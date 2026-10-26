'use strict';

// Standalone Trade Broker automation and diagnostic capture.
const fs = require('fs');
const path = require('path');
const PENDING = 35, NEGOTIATION = 36;
const DEFAULTS = {
  enabled: true,
  captureOnly: false,
  autoAcceptPercent: 100,
  autoRejectBelowPercent: 100,
  autoRejectAbovePercent: 200,
  rejectChancePercent: 15,
  unattendedManual: true,
  retryDelayMs: 250,
  requestTimeoutMs: 1500,
  negotiationTimeoutMs: 10000,
  offerLifetimeMs: 30000,
  combatOfferDelayMs: 0,
  combatQuietMs: 1,
  inputAckTimeoutMs: 1500
};

module.exports = function AutoSale(mod) {
  const configPath = path.join(__dirname, 'config.json');
  let config = readConfig(true), current = null, nextTimer = null, watchdog = null;
  let closed = false, logFile = null, lastOffer = null, serial = 0;
  const queue = [], recent = new Map(), visibleContracts = new Map(), hooks = [];
  let action = null, pendingInput = null, inputUntil = 0, quietUntil = 0, moving = false;
  let inputGeneration = 0, pendingGeneration = 0;
  const nativeIntents = new Map(), forwardedIntents = new Map();
  const activity = [];
  const isNegotiation = type => type === PENDING || type === NEGOTIATION;
  mod.game.initialize('me');

  function message(text) { mod.command.message(text); }
  function record(stage, data) {
    if (!logFile) return;
    const row = Object.assign({ time: new Date().toISOString(), stage,
      combat: Boolean(mod.game.me.inCombat), token: current && current.token,
      listing: current && current.listing, activity: activityState() }, data);
    try { fs.appendFileSync(logFile, JSON.stringify(row, (k, v) => typeof v === 'bigint' ? v.toString() : v) + '\n'); }
    catch (error) { logFile = null; mod.warn('Auto Sale log stopped: ' + error.message); }
  }
  function validate(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Expected a settings object');
    const result = Object.assign({}, DEFAULTS, value);
    for (const key of ['enabled', 'captureOnly', 'unattendedManual']) if (typeof result[key] !== 'boolean') throw Error(key + ' must be true or false');
    for (const key of ['autoAcceptPercent', 'autoRejectBelowPercent', 'autoRejectAbovePercent', 'rejectChancePercent']) {
      if (!Number.isInteger(result[key]) || result[key] < 0 || result[key] > (key === 'rejectChancePercent' ? 100 : 10000)) throw Error('Invalid ' + key);
    }
    for (const [key, min, max] of [['retryDelayMs',100,5000],['requestTimeoutMs',500,10000],['negotiationTimeoutMs',2000,60000],['offerLifetimeMs',5000,120000],['combatOfferDelayMs',0,3000],['combatQuietMs',1,1000],['inputAckTimeoutMs',500,5000]]) {
      if (!Number.isInteger(result[key]) || result[key] < min || result[key] > max) throw Error('Invalid ' + key);
    }
    return result;
  }
  function atomicWrite(file, text) {
    const temp = file + '.tmp';
    let fd;
    try {
      fd = fs.openSync(temp, 'w'); fs.writeFileSync(fd, text, 'utf8'); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      fs.renameSync(temp, file);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      if (fs.existsSync(temp)) fs.unlinkSync(temp);
    }
  }
  function readConfig(startup) {
    try {
      let bytes = fs.readFileSync(configPath), text;
      if (bytes[0] === 0xff && bytes[1] === 0xfe) text = bytes.slice(2).toString('utf16le');
      else if (bytes[0] === 0xfe && bytes[1] === 0xff) text = Buffer.from(bytes.slice(2)).swap16().toString('utf16le');
      else text = bytes.toString('utf8').replace(/^\uFEFF/, '');
      return validate(JSON.parse(text));
    } catch (error) {
      if (!startup) throw error;
      if (fs.existsSync(configPath)) {
        const backup = configPath + '.invalid-' + Date.now() + '.bak';
        try { fs.copyFileSync(configPath, backup, fs.constants.COPYFILE_EXCL); }
        catch (backupError) { mod.warn('Invalid settings; original kept: ' + backupError.message); return Object.assign({}, DEFAULTS); }
        mod.warn('Invalid sale settings backed up; defaults restored: ' + error.message);
      }
      const result = Object.assign({}, DEFAULTS);
      try { atomicWrite(configPath, JSON.stringify(result, null, 2) + '\n'); }
      catch (writeError) { mod.warn('Could not save sale defaults: ' + writeError.message); }
      return result;
    }
  }
  function save(next) {
    const valid = validate(next);
    atomicWrite(configPath, JSON.stringify(valid, null, 2) + '\n');
    config = valid;
  }
  function clearTimers() {
    mod.clearTimeout(nextTimer); mod.clearTimeout(watchdog); nextTimer = watchdog = null;
  }
  function send(name, event) {
    record('SEND', { packet: name, data: event });
    const sent = mod.toServer(name, 1, event);
    record('SEND_RESULT', { packet: name, sent: sent === true });
    return sent;
  }
  function compare(offer) {
    const offered = offer.offeredPrice, asked = offer.sellerPrice;
    const chance = () => Math.random() * 100 < config.rejectChancePercent;
    if (config.autoRejectBelowPercent && offered * 100n < asked * BigInt(config.autoRejectBelowPercent) && chance()) return -1;
    if (config.autoRejectAbovePercent && offered * 100n > asked * BigInt(config.autoRejectAbovePercent) && chance()) return -1;
    if (config.autoAcceptPercent && offered * 100n >= asked * BigInt(config.autoAcceptPercent)) return 1;
    return 0;
  }
  function offerFrom(event) {
    if (!Number.isInteger(event.playerId) || event.playerId < 0 || event.playerId > 0xffffffff ||
        !Number.isInteger(event.listing) || event.listing < 0 || event.listing > 0xffffffff) throw Error('Invalid offer identity');
    const offeredPrice = BigInt(event.offeredPrice), sellerPrice = BigInt(event.sellerPrice);
    if (offeredPrice <= 0n || sellerPrice <= 0n) throw Error('Invalid offer price');
    return { playerId: event.playerId, listing: event.listing, name: event.name,
      offeredPrice, sellerPrice, packet: Object.assign({}, event), expiresAt: Date.now() + config.offerLifetimeMs,
      receivedAt: Date.now(), readyAt: 0, attempts: 0, token: ++serial, confirmedStages: new Set(), contracts: new Map(), phase: 'queued' };
  }
  function prune() {
    const now = Date.now();
    // Only manual-review history expires. Pending automatic offers never age out.
    for (const [key, offer] of recent) if (offer.expiresAt <= now) recent.delete(key);
  }
  function schedule(delay) {
    if (closed || !config.enabled || config.captureOnly || current || nextTimer !== null) return;
    nextTimer = mod.setTimeout(() => { nextTimer = null; pump(); }, delay || 0);
  }
  function activityState() {
    return { actionId: action && action.id, skill: action && action.skill, moving,
      pendingInput, inputRemainingMs: Math.max(0, inputUntil - Date.now()),
      quietRemainingMs: Math.max(0, quietUntil - Date.now()) };
  }
  function remember(name, event) {
    if (!logFile) return;
    activity.push({ time: Date.now(), packet: name, skill: skillId(event), id: event.id,
      type: event.type, press: event.press, fake: Boolean(event.$fake), silenced: Boolean(event.$silenced),
      modified: Boolean(event.$modified) });
    if (activity.length > 32) activity.shift();
  }
  function skillId(event) { return typeof event.skill === 'number' ? event.skill : event.skill && event.skill.id; }
  function skillFamily(id) { return Number.isInteger(id) && id > 0 ? Math.floor(id / 100) : null; }
  function sameSkill(a, b) {
    // A forwarded base/chain ID can be acknowledged with another suffix, e.g.
    // 30200 -> 30230, 251000 -> 251030 or 210402 -> 210430. Keep ranks/phases
    // in different hundred groups separate; do not use a class-specific list.
    const family = skillFamily(a);
    return family !== null && family === skillFamily(b);
  }
  function safeToRequest() {
    // Observe real server actions, not emulators' early client animation ends.
    // Never cancel a skill or force an attempt after an arbitrary wait limit.
    return action === null && !moving && inputUntil <= Date.now() && quietUntil <= Date.now() &&
      mod.game.me.alive !== false && !mod.game.me.mounted && !mod.game.isInLoadingScreen;
  }
  function requestBlockers() {
    const now = Date.now(), result = [];
    if (action !== null) result.push('server-action');
    if (moving) result.push('movement');
    if (inputUntil > now) result.push('pending-input');
    if (quietUntil > now) result.push('outgoing-quiet');
    if (mod.game.me.alive === false) result.push('dead');
    if (mod.game.me.mounted) result.push('mounted');
    if (mod.game.isInLoadingScreen) result.push('loading');
    if (visibleContracts.size) result.push('visible-contract');
    return result;
  }
  function visibleState() {
    return Array.from(visibleContracts, ([type, id]) => ({ type, id }));
  }
  function recordState(reason) {
    record('STATE', { reason, blockers: requestBlockers(), visibleContracts: visibleState(),
      current: current && { phase: current.phase, attempts: current.attempts, contract: current.contract,
        handshakeAccepted: Boolean(current.handshakeAccepted), nativeRequest: Boolean(current.nativeRequest) },
      queued: queue.map(offer => ({ listing: offer.listing, decision: offer.decision, waitedMs: Date.now() - offer.receivedAt })),
      lastOffer: lastOffer && { listing: lastOffer.listing, decision: lastOffer.decision,
        phase: lastOffer.phase, finished: Boolean(lastOffer.finished), ageMs: Date.now() - lastOffer.receivedAt } });
  }
  function recordWait(offer) {
    if (!logFile) return;
    const now = Date.now();
    if (offer.nextWaitLogAt && now < offer.nextWaitLogAt) return;
    offer.nextWaitLogAt = now + 2000;
    record(offer.waitingLogged ? 'REQUEST_WAITING' : 'REQUEST_DEFERRED', {
      listing: offer.listing, waitedMs: now - offer.receivedAt,
      blockers: requestBlockers(), visibleContracts: visibleState(), trace: activity.slice()
    });
    offer.waitingLogged = true;
  }
  function wakeQueued() {
    if (current && current.phase === 'retry-wait') { continueRetry(); return; }
    if (!queue.length || current) return;
    // One timer at the quiet deadline, instead of a zero-delay timer followed
    // by a second timer. The callback still rechecks every activity guard.
    mod.clearTimeout(nextTimer); nextTimer = null;
    schedule(Math.max(0, quietUntil - Date.now()));
  }
  function pump(source) {
    if (closed || !config.enabled || config.captureOnly) return;
    if (current) {
      if (current.phase === 'retry-wait') continueRetry(source);
      return;
    }
    prune();
    if (!queue.length) return;
    if (visibleContracts.size) {
      recordWait(queue[0]); schedule(50); return;
    }
    const now = Date.now(), index = queue.findIndex(offer => offer.readyAt <= now);
    if (index < 0) { schedule(Math.max(0, Math.min.apply(null, queue.map(o => o.readyAt)) - now)); return; }
    if (queue[index].decision === 1 && !safeToRequest()) {
      recordWait(queue[index]);
      const wait = Math.max(inputUntil, quietUntil) - now;
      schedule(action !== null || moving || wait <= 0 ? 50 : Math.min(50, wait)); return;
    }
    const offer = queue.splice(index, 1)[0];
    if (offer.decision === -1) {
      send('C_TRADE_BROKER_REJECT_SUGGEST', { playerId: offer.playerId, listing: offer.listing });
      record('DECLINED', { listing: offer.listing }); schedule(); return;
    }
    beginRequest(offer, source);
  }
  function beginRequest(offer, source) {
    current = offer; offer.phase = 'requesting'; offer.attempts++;
    offer.nativeRequest = false;
    record('SAFE_REQUEST_WINDOW', { source: source || 'timer', waitedMs: Date.now() - offer.receivedAt, trace: activity.slice() });
    offer.confirmedStages.clear(); offer.contracts.clear(); offer.contract = null; offer.lastSellerStage = -1;
    offer.handshakeAccepted = false;
    offer.pendingReplySeen = false;
    if (offer.attempts === 1) message('Handling sale offer #' + offer.listing + '.');
    const data = Buffer.alloc(30); data.writeUInt32LE(offer.playerId, 0); data.writeUInt32LE(offer.listing, 4);
    armWatchdog(config.requestTimeoutMs);
    try {
      if (send('C_REQUEST_CONTRACT', { type: PENDING, unk2: 0, unk3: 0, unk4: 0, name: '', data }) === false) retry('request-blocked-locally');
    }
    catch (error) { record('SEND_FAILED', { reason: error.message }); retry('request-send-failed'); }
  }
  function armWatchdog(delay) {
    mod.clearTimeout(watchdog);
    const owner = current;
    watchdog = mod.setTimeout(() => {
      watchdog = null;
      if (current !== owner) return;
      if (owner.phase === 'cancelling') finish(owner.closeReason);
      else if (owner.phase === 'closing' || owner.confirmedStages.has(2)) cancelAndFinish('final-response-timeout', false);
      else retry('server-response-timeout');
    }, Math.max(1, delay));
  }
  function cancelOwned(offer) {
    if (offer && offer.contract) send('C_CANCEL_CONTRACT', { type: offer.contract.type, id: offer.contract.id });
  }
  function finish(reason) {
    if (!current) return;
    record('FINISH', { reason, attempts: current.attempts });
    current.finished = true;
    recent.delete(current.playerId + '-' + current.listing);
    mod.clearTimeout(watchdog); watchdog = null;
    current = null;
    schedule();
  }
  function cancelAndFinish(reason) {
    if (!current) return;
    if (!current.contract) { finish(reason); return; }
    // Wait for the owned cancel acknowledgement before starting another request.
    current.phase = 'cancelling'; current.closeReason = reason;
    armWatchdog(config.requestTimeoutMs);
    cancelOwned(current);
  }
  function retry(reason) {
    const offer = current;
    if (!offer) return;
    // A final confirmation may already have sold the listing. Never replay it on uncertainty.
    if (offer.confirmedStages.has(2)) { cancelAndFinish('final-confirmation-already-sent', false); return; }
    // Once accepted, do not open another negotiation on a stalled/uncertain sale.
    if (offer.handshakeAccepted || offer.contract) {
      record('ATTEMPT_STOPPED', { reason, attempts: offer.attempts, trace: activity.slice() });
      cancelAndFinish(reason); return;
    }
    record('RETRY_PENDING', { reason, attempts: offer.attempts, delayMs: config.retryDelayMs, trace: activity.slice() });
    offer.phase = 'retry-wait'; offer.readyAt = Date.now() + config.retryDelayMs;
    continueRetry();
  }
  function continueRetry(source) {
    const offer = current;
    if (!offer || offer.phase !== 'retry-wait' || offer.handshakeAccepted || offer.contract || offer.confirmedStages.size) return;
    mod.clearTimeout(watchdog); watchdog = null;
    const remaining = offer.readyAt - Date.now();
    if (remaining <= 0 && !visibleContracts.size && safeToRequest()) {
      beginRequest(offer, source || 'retry-window'); return;
    }
    if (remaining <= 0) recordWait(offer);
    // Keep ownership while waiting: a late acceptance stops the retry timer.
    watchdog = mod.setTimeout(() => {
      watchdog = null;
      if (current === offer && offer.phase === 'retry-wait') pump();
    }, remaining > 0 ? remaining : 50);
  }
  function owned(event) {
    return current && current.contracts.get(event.type) === event.id;
  }
  function matchesOfferContract(event) {
    if (!current || !Buffer.isBuffer(event.data)) return false;
    const data = event.data;
    // Captured server packets name the seller, not necessarily the buyer.
    // Match the embedded offer identity instead of sender/recipient display names.
    if (event.type === PENDING) return data.length >= 8 &&
      data.readUInt32LE(0) === current.playerId && data.readUInt32LE(4) === current.listing;
    if (event.type !== NEGOTIATION || data.length < 32) return false;
    try {
      return data.readUInt32LE(0) === current.listing &&
        data.readInt32LE(4) === current.packet.item &&
        data.readBigInt64LE(8) === BigInt(current.packet.amount) &&
        data.readBigInt64LE(24) >= current.offeredPrice;
    } catch (_) { return false; }
  }
  function hook(name, version, handler, options) {
    hooks.push(mod.hook(name, version, options || { order: 100, filter: { fake: false } }, handler));
  }

  hook('S_TRADE_BROKER_DEAL_SUGGESTED', 1, event => {
    record('OFFER', { data: event });
    if (!config.enabled || config.captureOnly) return;
    let offer;
    try { offer = offerFrom(event); } catch (error) { record('INVALID_OFFER', { reason: error.message }); return; }
    lastOffer = offer;
    const key = offer.playerId + '-' + offer.listing;
    prune();
    const previous = recent.get(key);
    if (previous && previous.stalled && previous.offeredPrice === offer.offeredPrice && previous.sellerPrice === offer.sellerPrice) {
      record('DUPLICATE_STALLED_OFFER'); return;
    }
    for (let i = queue.length - 1; i >= 0; --i) if (queue[i].playerId === offer.playerId && queue[i].listing === offer.listing) queue.splice(i, 1);
    recent.delete(key);
    if (current && current.playerId === offer.playerId && current.listing === offer.listing) {
      // A replacement price must never silently lower the price already accepted.
      if (offer.offeredPrice !== current.offeredPrice || offer.sellerPrice !== current.sellerPrice) {
        cancelAndFinish('offer-replaced', false);
      } else { lastOffer = current; record('DUPLICATE_OFFER'); return; }
    }
    offer.decision = compare(offer);
    // Keep the game's offer message visible, including its manual Accept fallback.
    if (offer.decision !== 0) {
      offer.readyAt = Date.now() + (mod.game.me.inCombat && offer.decision === 1 ? config.combatOfferDelayMs : 0);
      queue.push(offer); schedule(); return;
    }
    if (config.unattendedManual) recent.set(key, offer);
  });
  hook('S_TRADE_BROKER_REQUEST_DEAL_RESULT', 1, event => {
    record('REQUEST_RESULT', { ok: event.ok });
    if (!current) return;
    if (current.phase === 'cancelling') return false;
    if (current.handshakeAccepted) return false;
    if (!event.ok) retry('server-refused-request');
    else { current.handshakeAccepted = true; current.phase = 'negotiating'; armWatchdog(config.negotiationTimeoutMs); }
    return false;
  });
  hook('S_REQUEST_CONTRACT', mod.majorPatchVersion >= 108 ? 2 : 1, event => {
    record('CONTRACT_OPEN', { type: event.type, id: event.id, dataLength: event.data && event.data.length });
    if (current && isNegotiation(event.type) && matchesOfferContract(event)) {
      if (current.phase === 'cancelling') {
        current.contract = { type: event.type, id: event.id }; current.contracts.set(event.type, event.id);
        cancelOwned(current); return false;
      }
      current.contract = { type: event.type, id: event.id }; current.contracts.set(event.type, event.id);
      current.handshakeAccepted = true;
      current.phase = 'negotiating'; armWatchdog(config.negotiationTimeoutMs); return false;
    }
    if (current && isNegotiation(event.type)) record('CONTRACT_IGNORED', { type: event.type, id: event.id, reason: 'offer-identity-mismatch' });
  });
  hook('S_REPLY_REQUEST_CONTRACT', 1, event => {
    if (isNegotiation(event.type)) record('CONTRACT_REPLY', { type: event.type });
    if (current && event.type === PENDING) {
      // This reply has no success flag or contract ID. It is not proof of progress.
      current.pendingReplySeen = true;
      // The automatic request never originated from the client. Do not let its
      // reply enter the client's request/UI state, even when the server refuses
      // to create a contract. Native handoffs get their own indicator reply.
      record('OWN_REQUEST_REPLY_HIDDEN', { nativeRequest: Boolean(current.nativeRequest), trace: activity.slice() });
      return false;
    }
  });
  hook('S_ACCEPT_CONTRACT', 1, event => {
    if (isNegotiation(event.type)) record('CONTRACT_ACCEPT', { data: event });
    // Some flows report acceptance without a preceding S_REQUEST_CONTRACT.
    if (current && ['requesting', 'retry-wait'].includes(current.phase) && current.pendingReplySeen &&
        event.type === PENDING && Number.isInteger(event.id) && !visibleContracts.size && !current.contract) {
      current.contract = { type: event.type, id: event.id }; current.contracts.set(event.type, event.id);
    }
    if (owned(event)) {
      if (current.phase !== 'cancelling') { current.handshakeAccepted = true; current.phase = 'negotiating'; armWatchdog(config.negotiationTimeoutMs); }
      return false;
    }
  });
  hook('S_TRADE_BROKER_DEAL_INFO_UPDATE', 1, event => {
    record('DEAL_STAGE', { data: event });
    if (!current) return;
    const knownContract = current.contract && current.contract.type === NEGOTIATION;
    // Deal updates have no contract ID. Only handle them after our own handshake,
    // with no competing visible contract; a separate type-36 packet is optional.
    if (visibleContracts.size || (!knownContract && !current.handshakeAccepted)) {
      record('DEAL_STAGE_IGNORED', { reason: visibleContracts.size ? 'other-visible-contract' : 'no-handshake' }); return;
    }
    if (current.phase === 'cancelling') return false;
    if (![0, 1, 2].includes(event.sellerStage) || ![0, 1, 2].includes(event.buyerStage)) {
      record('DEAL_STAGE_IGNORED', { reason: 'invalid-stage' }); return;
    }
    let price;
    try { price = BigInt(event.price); } catch (_) { retry('invalid-price'); return false; }
    if (price < current.offeredPrice) { cancelAndFinish('price-below-accepted-offer', false); return false; }
    if (event.sellerStage < current.lastSellerStage) return false;
    current.lastSellerStage = event.sellerStage;
    if (current.phase === 'closing') return false;
    current.phase = 'negotiating'; armWatchdog(config.negotiationTimeoutMs);
    if (event.buyerStage === 2 && (event.sellerStage === 0 || event.sellerStage === 1)) {
      const stage = event.sellerStage + 1;
      if (!current.confirmedStages.has(stage)) {
        current.confirmedStages.add(stage); armWatchdog(config.negotiationTimeoutMs);
        send('C_TRADE_BROKER_DEAL_CONFIRM', { listing: current.listing, stage });
      }
    } else if (event.buyerStage === 2 && event.sellerStage === 2) {
      current.phase = 'closing'; armWatchdog(config.requestTimeoutMs);
    }
    return false;
  });
  for (const packet of ['S_CANCEL_CONTRACT', 'S_REJECT_CONTRACT']) hook(packet, 1, event => {
    if (isNegotiation(event.type)) record(packet, { type: event.type, id: event.id, owned: Boolean(owned(event)) });
    if (owned(event)) {
      if (current.contract.type !== event.type || current.contract.id !== event.id) return false;
      current.contract = null;
      if (current.phase === 'cancelling') { finish(current.closeReason); return false; }
      if (packet === 'S_REJECT_CONTRACT') {
        if (event.type === PENDING) send('C_TRADE_BROKER_REJECT_SUGGEST', { playerId: current.playerId, listing: current.listing });
        finish('buyer-rejected');
      } else if (current.phase === 'closing' || current.confirmedStages.has(2)) finish('contract-closed-after-confirmation');
      else retry('server-cancelled-contract');
      return false;
    }
  });
  // This is client-window state, separate from server-side negotiation ownership.
  // Observe the final visible result: instant modules can close windows locally,
  // and later hooks can hide a real contract before it ever reaches the client.
  const visibleWindow = { order: Number.MAX_SAFE_INTEGER, filter: { fake: null, modified: null, silenced: false } };
  hook('S_REQUEST_CONTRACT', mod.majorPatchVersion >= 108 ? 2 : 1, event => {
    if (!Number.isInteger(event.type) || !Number.isInteger(event.id)) return;
    visibleContracts.set(event.type, event.id);
    record('VISIBLE_CONTRACT_OPEN', { type: event.type, id: event.id, fake: Boolean(event.$fake) });
  }, visibleWindow);
  function closeVisible(event, packet) {
    if (visibleContracts.get(event.type) !== event.id) return;
    visibleContracts.delete(event.type);
    record('VISIBLE_CONTRACT_CLOSE', { packet, type: event.type, id: event.id, fake: Boolean(event.$fake) });
    wakeQueued();
  }
  for (const name of ['S_ACCEPT_CONTRACT', 'S_CANCEL_CONTRACT', 'S_REJECT_CONTRACT'])
    hook(name, 1, event => closeVisible(event, name), visibleWindow);
  // A native cancellation may have no server echo. Only an actually forwarded
  // client close releases its exact window; hidden or synthetic sends do not.
  const visibleInput = { order: Number.MAX_SAFE_INTEGER, filter: { fake: false, modified: null, silenced: false } };
  hook('C_CANCEL_CONTRACT', 1, event => closeVisible(event, 'C_CANCEL_CONTRACT'), visibleInput);
  hook('C_TRADE_BROKER_CLOSE', 'raw', () => {
    if (!visibleContracts.has(28)) return;
    const id = visibleContracts.get(28);
    visibleContracts.delete(28);
    record('VISIBLE_CONTRACT_CLOSE', { packet: 'C_TRADE_BROKER_CLOSE', type: 28, id });
    wakeQueued();
  }, visibleInput);
  hook('C_CANCEL_CONTRACT', 1, event => {
    if (owned(event)) {
      // Respect the client's cancellation instead of forcing a contract to stay open.
      record('CLIENT_CANCEL_RELEASED', { type: event.type, id: event.id });
      current.phase = 'cancelling'; current.closeReason = 'client-cancelled';
      armWatchdog(config.requestTimeoutMs);
    }
  }, { order: -100, filter: { fake: false } });
  hook('C_REQUEST_CONTRACT', 1, event => {
    if (!config.enabled || config.captureOnly || !config.unattendedManual || event.type !== PENDING || !Buffer.isBuffer(event.data) || event.data.length < 8) return;
    prune();
    const playerId = event.data.readUInt32LE(0), listing = event.data.readUInt32LE(4);
    if (current && current.playerId === playerId && current.listing === listing) {
      if (current.phase === 'retry-wait') {
        current.phase = 'requesting'; current.nativeRequest = true; current.attempts++;
        armWatchdog(config.requestTimeoutMs); record('MANUAL_ACCEPT_HANDOFF');
        const owner = current;
        mod.setTimeout(() => { if (current === owner && !closed) mod.toClient('S_REPLY_REQUEST_CONTRACT', 1, { type: PENDING }); }, 0);
        return;
      }
      record('MANUAL_ACCEPT_ALREADY_HANDLED');
      mod.toClient('S_REPLY_REQUEST_CONTRACT', 1, { type: PENDING }); return false;
    }
    const key = playerId + '-' + listing;
    const queued = queue.findIndex(o => o.playerId === playerId && o.listing === listing);
    const offer = queued >= 0 ? queue[queued] : recent.get(key);
    if (!offer) return;
    if (queued >= 0) queue.splice(queued, 1);
    if (current) {
      recent.delete(key); offer.decision = 1; queue.push(offer); record('MANUAL_ACCEPT_QUEUED', { listing: offer.listing });
      mod.toClient('S_REPLY_REQUEST_CONTRACT', 1, { type: PENDING }); return false;
    }
    recent.delete(key); mod.clearTimeout(nextTimer); nextTimer = null;
    current = offer; current.phase = 'requesting'; current.decision = 1; current.attempts++;
    current.nativeRequest = true;
    current.handshakeAccepted = false;
    current.pendingReplySeen = false;
    current.confirmedStages.clear(); current.contracts.clear(); current.contract = null; current.lastSellerStage = -1;
    armWatchdog(config.requestTimeoutMs); record('MANUAL_ACCEPT_HANDOFF');
    // Close only the pending client request indicator; no sale window is opened.
    const owner = current;
    mod.setTimeout(() => { if (current === owner && !closed) mod.toClient('S_REPLY_REQUEST_CONTRACT', 1, { type: PENDING }); }, 0);
  }, { order: -100, filter: { fake: false } });
  const observation = { order: Number.MAX_SAFE_INTEGER, filter: { fake: null, modified: null, silenced: false } };
  for (const [name, version] of [['C_START_SKILL',7], ['C_START_TARGETED_SKILL',7],
    ['C_START_INSTANCE_SKILL',7], ['C_START_INSTANCE_SKILL_EX',5], ['C_START_COMBO_INSTANT_SKILL',6], ['C_PRESS_SKILL',4]]) {
    hook(name, version, event => {
      if (event.press === false) return;
      const family = skillFamily(skillId(event));
      if (family === null) return;
      nativeIntents.set(family, ++inputGeneration);
      if (nativeIntents.size > 64) nativeIntents.delete(nativeIntents.keys().next().value);
    }, { order: -Number.MAX_SAFE_INTEGER, filter: { fake: false, silenced: null, modified: null } });
    hook(name, version, event => {
      remember(name, event);
      const id = skillId(event), family = skillFamily(id), generation = nativeIntents.get(family) || 0;
      if (event.$fake && event.press !== false) {
        // A synthetic retry of an already acknowledged action is not a new
        // outstanding skill. A fresh physical press retains its own guard.
        if (pendingInput === null && action && sameSkill(id, action.skill) && generation <= action.generation) return;
        if (sameSkill(id, pendingInput) && generation <= pendingGeneration && inputUntil > Date.now()) return;
      }
      quietUntil = Date.now() + config.combatQuietMs;
      if (event.press === false) {
        if (sameSkill(pendingInput, id)) { pendingInput = null; inputUntil = 0; wakeQueued(); }
      } else {
        pendingInput = id; pendingGeneration = generation; inputUntil = Date.now() + config.inputAckTimeoutMs;
        forwardedIntents.set(family, generation);
        if (forwardedIntents.size > 64) forwardedIntents.delete(forwardedIntents.keys().next().value);
      }
      // Observation only: never change, hold or replay a skill input.
    }, observation);
  }
  hook('C_USE_PREMIUM_SLOT', 1, event => {
    remember('C_USE_PREMIUM_SLOT', event);
    pendingInput = event.id; inputUntil = Date.now() + config.inputAckTimeoutMs;
    pendingGeneration = nativeIntents.get(skillFamily(event.id)) || 0;
    quietUntil = Date.now() + config.combatQuietMs;
  }, observation);
  hook('C_USE_ITEM', 3, event => {
    remember('C_USE_ITEM', event); quietUntil = Date.now() + config.combatQuietMs;
  }, observation);
  hook('C_PLAYER_LOCATION', 5, event => {
    remember('C_PLAYER_LOCATION', event);
    // Protocol: 7 = stop/landing, 9 = stop swimming. Continued movement is not
    // a safe contract window; no position packets are fabricated or held.
    moving = event.type !== 7 && event.type !== 9;
    if (!moving) { quietUntil = Date.now() + config.combatQuietMs; wakeQueued(); }
  }, observation);
  const serverObservation = { order: Number.MAX_SAFE_INTEGER, filter: { fake: false, modified: null, silenced: null } };
  // Read original server IDs before animation modules translate them into
  // client prediction IDs. Refusals must still use their FINAL silenced flag.
  const originalAction = { order: -Number.MAX_SAFE_INTEGER, filter: { fake: false, modified: null, silenced: null } };
  hook('S_ACTION_STAGE', 9, event => {
    if (event.gameId !== mod.game.me.gameId) return;
    remember('S_ACTION_STAGE', event);
    const id = skillId(event), matchesInput = sameSkill(pendingInput, id);
    action = { id: event.id, skill: id,
      generation: matchesInput ? pendingGeneration : forwardedIntents.get(skillFamily(id)) || 0 };
    if (matchesInput) { pendingInput = null; inputUntil = 0; }
  }, originalAction);
  hook('S_ACTION_END', 5, event => {
    if (event.gameId !== mod.game.me.gameId) return;
    remember('S_ACTION_END', event);
    if (action && action.id === event.id) {
      action = null;
      // The server has already ended this action. Its acknowledgement does not
      // start another outgoing quiet wait. If the existing input/quiet guards
      // are clear, use this boundary before a later stage/timer closes it.
      // Outbound stop/release hooks still use timers: their packets must reach
      // the server before a request is sent.
      if ((queue.length && !current || current && current.phase === 'retry-wait') && safeToRequest() && !visibleContracts.size) {
        mod.clearTimeout(nextTimer); nextTimer = null;
        pump('server-action-end');
      } else wakeQueued();
    }
  }, originalAction);
  hook('S_CANNOT_START_SKILL', 4, event => {
    remember('S_CANNOT_START_SKILL', event);
    // A refusal hidden by an emulator never reaches the native client. Its
    // forwarded input may still be retried, so this is not evidence of idle.
    // Keep the existing bounded input guard until acknowledgement/release or
    // expiry. A visible refusal can finish the client's outstanding input.
    if (!event.$silenced && sameSkill(pendingInput, skillId(event))) { pendingInput = null; inputUntil = 0; }
    quietUntil = Date.now() + config.combatQuietMs;
    wakeQueued();
  }, serverObservation);
  for (const packet of ['C_REQUEST_CONTRACT', 'C_CANCEL_CONTRACT', 'C_ACCEPT_CONTRACT', 'C_REJECT_CONTRACT',
    'C_TRADE_BROKER_DEAL_CONFIRM', 'C_TRADE_BROKER_DEAL_PRICE_UPDATE',
    'S_REQUEST_CONTRACT', 'S_REPLY_REQUEST_CONTRACT', 'S_ACCEPT_CONTRACT', 'S_CANCEL_CONTRACT',
    'S_REJECT_CONTRACT', 'S_TRADE_BROKER_REQUEST_DEAL_RESULT', 'S_TRADE_BROKER_DEAL_INFO_UPDATE']) {
    hook(packet, packet === 'S_REQUEST_CONTRACT' && mod.majorPatchVersion >= 108 ? 2 : 1, event => {
      if (event.type !== undefined && !isNegotiation(event.type)) return;
      record('PACKET_AUDIT', { packet, fake: Boolean(event.$fake), silenced: Boolean(event.$silenced),
        modified: Boolean(event.$modified), data: event });
    }, { order: Number.MAX_SAFE_INTEGER, filter: { fake: null, silenced: null, modified: null } });
  }
  hook('S_SYSTEM_MESSAGE', 1, event => {
    let parsed;
    try { parsed = mod.parseSystemMessage(event.message); } catch (_) { return; }
    if (/^SMT_MEDIATE_/.test(parsed.id)) record('SYSTEM_MESSAGE', { id: parsed.id });
    if (!current) return;
    if (parsed.id === 'SMT_MEDIATE_SUCCESS_SELL') {
      if (!current.saleConfirmed) { message('Sale completed.'); current.saleConfirmed = true; }
      cancelAndFinish('sale-confirmed', false);
    } else if (parsed.id === 'SMT_MEDIATE_TRADE_CANCEL_OPPONENT') {
      cancelAndFinish('buyer-cancelled', false);
    }
  });
  function reset(reason, cancel) {
    if (cancel) cancelOwned(current);
    record('RESET', { reason }); clearTimers(); current = null; queue.length = 0; recent.clear(); visibleContracts.clear(); lastOffer = null;
    if (['login', 'lobby', 'map-change', 'unload'].includes(reason)) {
      action = pendingInput = null; inputUntil = quietUntil = 0; moving = false; activity.length = 0;
      inputGeneration = pendingGeneration = 0; nativeIntents.clear(); forwardedIntents.clear();
    }
  }
  hook('S_LOGIN', 'raw', () => { reset('login', false); });
  hook('S_RETURN_TO_LOBBY', 'raw', () => { reset('lobby', false); });
  hook('S_LOAD_TOPO', 'raw', () => { reset('map-change', true); });
  function retryLast() {
    if (!config.enabled) { message('Auto Sale is OFF. Use sale on.'); return; }
    if (config.captureOnly) { message('Capture mode is active. Use sale on to enable automation.'); return; }
    prune();
    if (!lastOffer || lastOffer.finished) { message('No pending offer to retry.'); return; }
    if (current || queue.some(o => o.playerId === lastOffer.playerId && o.listing === lastOffer.listing)) { message('Offer is already being handled.'); return; }
    if (lastOffer.confirmedStages.has(2) || lastOffer.phase === 'closing') { message('Final confirmation was already sent; waiting for a new offer.'); return; }
    lastOffer.decision = compare(lastOffer);
    if (!lastOffer.decision) { mod.toClient('S_TRADE_BROKER_DEAL_SUGGESTED', 1, lastOffer.packet); message('Offer shown for manual review.'); return; }
    lastOffer.readyAt = 0; lastOffer.stalled = false; queue.push(lastOffer); schedule();
  }
  function startLog() {
    if (logFile) return;
    const dir = path.join(__dirname, 'logs'); fs.mkdirSync(dir, { recursive: true });
    logFile = path.join(dir, 'sale-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + process.pid + '.jsonl');
    record('LOG_START', { settings: config }); recordState('log-start'); message('Sale log ON.');
  }
  mod.command.add('sale', (arg, value) => {
    try {
      switch ((arg || 'status').toLowerCase()) {
        case 'on': save(Object.assign({}, config, { enabled: true, captureOnly: false })); schedule(); message('Auto Sale ON.'); break;
        case 'capture': {
          save(Object.assign({}, config, { captureOnly: true }));
          reset('capture-mode', true); startLog();
          message('Capture mode: automation paused; manual Negotiate and confirmations pass unchanged.'); break;
        }
        case 'off': save(Object.assign({}, config, { enabled: false })); reset('disabled', true); message('Auto Sale OFF.'); break;
        case 'reload': {
          const next = readConfig(false); config = next;
          if (!config.enabled || config.captureOnly) reset('paused-by-reload', true); else schedule();
          message('Auto Sale settings reloaded.'); break;
        }
        case 'retry': retryLast(); break;
        case 'log': {
          if (logFile) { record('LOG_STOP'); message('Auto Sale log saved: ' + path.basename(logFile)); logFile = null; }
          else startLog();
          break;
        }
        case 'accept': save(Object.assign({}, config, { autoAcceptPercent: Number(value) })); message('Accept threshold: ' + config.autoAcceptPercent + '%.'); break;
        case 'status': {
          const blockers = requestBlockers(), windows = visibleState();
          recordState('status');
          message('Auto Sale ' + (config.captureOnly ? 'CAPTURE (automation paused)' : config.enabled ? 'ON' : 'OFF') + ' | accept ' + config.autoAcceptPercent + '% | ' + (current ? current.phase + ', attempt ' + current.attempts : 'idle') + ' | queued ' + queue.length +
            ((queue.length || current && current.phase === 'retry-wait') && blockers.length ? ' | waiting: ' + blockers.join(', ') : '') +
            (windows.length ? ' | windows: ' + windows.map(window => window.type + ':' + window.id).join(', ') : '') + ' | log ' + (logFile ? 'ON' : 'OFF')); break;
        }
        default: message('sale on/off/status/reload/retry/log/capture | sale accept <percent>');
      }
    } catch (error) { message('Auto Sale settings unchanged: ' + error.message); }
  });

  this.destructor = () => {
    reset('unload', true); closed = true; logFile = null;
    mod.command.remove('sale');
    for (const handle of hooks) mod.unhook(handle);
  };
};
