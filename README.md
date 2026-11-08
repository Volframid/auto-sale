# Auto Sale

Trade Broker offer automation. Author: CEM.

Automatically handles offers that meet your configured price threshold. Confirmations are sent immediately when the server reports the required sale stage. The module does not send skill or movement packets.

The first automatic request observes real server action ends. At a matching end, it sends immediately if the existing input, movement and outgoing quiet checks are already clear. It does not add another timer delay after that confirmation. A pending next skill still blocks the request. Movement waits for the game's stop packet; combat itself does not block sales. Automatic request replies stay hidden from the client so they do not enter its native request UI state.

Action matching uses the original server IDs before animation modules change them into client prediction IDs. Outbound stop/release events use the quiet timer so their packets go to the server first. All guards are checked again before sending the request.

Server acknowledgements can use a different suffix from the sent skill (for example, `30200` → `30230`). These variants clear the input guard. Synthetic retries of the same acknowledged action do not create a new wait; new physical inputs remain guarded.

A skill refusal hidden from the game client does not clear the outstanding input: an emulator may still be retrying it. Acknowledgement, release or the bounded input deadline resolves that guard. A block ending alone does not create a free window while another input is pending.

Continuous attacks or movement can postpone the request until a suitable window. Pending automatic offers stay queued without a time limit. An unanswered or refused initial request retries after `retryDelayMs` (default 100 ms), checking the same gameplay guards each time. Each sent request waits for its response timeout before another attempt; requests never overlap. Buyer approval is still required.

Window tracking follows the final client-visible packets, including windows opened or closed locally by other modules. A forwarded native cancellation or rejection clears only its matching contract type and ID, even without a server closing reply. Hidden or synthetic outgoing packets do not release a visible window; the broker-specific close clears only the broker window.

Once the server accepts a request, the module handles the negotiation instead of reopening it. Buyer rejection, client cancellation, map/session changes and `sale off` stop the operation. A final sale confirmation is never replayed after an uncertain result. The game offer message remains visible for manual Negotiate.

Negotiation contracts are matched using their embedded player/listing information and item, quantity and price. Display names are not used to identify the buyer: this server can place the seller's name in those fields.

## Installation

Place the `auto-sale` folder in Toolbox's `mods` folder and restart Toolbox. Keep only one negotiation module enabled.

## Commands

| Command | Action |
| --- | --- |
| `sale` / `sale status` | Show mode and settings |
| `sale on` | Enable automation and leave capture mode |
| `sale off` | Disable automation |
| `sale accept 100` | Accept offers at 100% or more of the asking price; 0 disables automatic acceptance |
| `sale reload` | Reload `config.json`; invalid settings keep the running configuration |
| `sale retry` | Resume an available offer; already pending offers are not duplicated |
| `sale log` | Start or stop the diagnostic log |
| `sale capture` | Pause automation and start a passive log of manual negotiation |

## Manual capture

Use `sale capture`, receive an offer, and click the game's **Negotiate** link. Let the other player answer the dialog. You can cancel the negotiation without completing a sale. Finish recording with `sale log`.

Capture mode preserves manual request, dialog, confirmation and cancellation packets. It sends no automatic offers or sale confirmations. The mode stays saved across restarts; use `sale on` to resume automation. Record whether the attempt was made during a fight or outside combat.

Logs are saved under `logs/sale-*.jsonl`. They include native request fields, server replies, sale stages, packet suppression and the recent action trace around an automatic request. Activity is kept in a small memory buffer rather than writing every movement/skill packet to disk. Buyer names and prices may appear; exclude personal logs from shared packages.

## Settings and updates

Settings are saved in `config.json`. The default price rules accept offers at 100%, and consider rejecting offers below 100% or above 200% with a 15% rejection chance. A manually accepted offer authorizes the displayed price.

`captureOnly` pauses automation for diagnostics. `requestTimeoutMs` detects a request without progress; `retryDelayMs` sets the pause before another eligible attempt. `negotiationTimeoutMs` detects an already accepted negotiation that has stalled. Legacy `offerLifetimeMs` applies only to manual-review history and never expires pending automatic offers.

`combatQuietMs` sets the quiet window after outgoing activity (default/minimum 1 ms). A real action end does not restart that window. `combatOfferDelayMs` adds an initial in-combat wait (default 0). `inputAckTimeoutMs` guards a forwarded input awaiting a server acknowledgement (1500 ms); duplicate synthetic retries do not extend it. Existing server actions wait for their actual end; this timeout never unlocks an active action. The quiet window is a requested timer delay, not a guarantee of exact wall-clock execution. Edit these values and use `sale reload` to apply settings. Updating code requires a Toolbox restart.

While logging, waiting offers record the current blockers and a short activity trace every two seconds, with request and retry traces. This records the reason for a prolonged wait without logging every skill packet separately.

The automatic request matches the captured native request byte for byte. Version 1.0.9 completed two server-confirmed sales during combat in the reviewed GF 100.2 / protocol 376012 log. First requests waited approximately 10.0 and 3.2 seconds for suitable gameplay windows; both succeeded on the first attempt. This does not establish compatibility with every server or guarantee a fixed acceptance time. The 100 ms retry setting still needs a live refusal/timeout test.

Automatic updates use this repository’s `main` branch. Existing `config.json` files are preserved by the update manifest. GPL-3.0 license text is retained in `LICENSE`.
