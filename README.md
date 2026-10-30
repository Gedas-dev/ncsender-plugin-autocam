# AutoCAM for ncSender

STEP file in, checked G-code out, inside ncSender. AutoCAM finds the pockets, holes and outline, plans the job with the tools loaded in ncSender, simulates it, and loads it.

![Part step](docs/1-part.jpg)

## Install

ncSender → **Settings → Plugins → Install Plugin → ZIP** → `ncsender-plugin-autocam.zip` → **Install from File** → **Enable**.
Open it from the **Plugins** tab → **AutoCAM**.

## 1 · Part

Open or drop a `.step` / `.stp` file (mm).
- AutoCAM picks the side to face up. It prefers a side that reaches everything in one setup and isn't too tall for the Z travel; if no side does, it switches on two setups.
- It turns the part so its long side runs along the machine's long axis.
- Pick another side, click a flat face, or **Turn 90°**.
- **How it sits on the table** shows which face is up, which faces you, and the size along X, Y and Z.

## 2 · Stock & zero

![Stock & zero](docs/2-stock-zero.jpg)

- **Material** sets speeds, feeds and depth per pass.
- **Stock block** is the part plus a margin on each side and on top.
- **Work zero (G54)**: any of 9 points (corners, edge middles, centre), clicked on the stock or on the small top view. Z goes on the stock top or on the spoilboard.
- **Setups**: one, or two with the block turned over (see below).

## 3 · Operations

![Operations](docs/3-operations.jpg)

The plan is made in the background and updates on every change.
- **Job time** shows the total, with each step's share as a coloured bar.
- **Sequence**: Face the top → Rough out → Finish walls → Clean up corners → Finish corners → Spot drill → Drill.
  - You can change the tool for facing, roughing and corners.
  - Untick any step except roughing.
- **Wall finish**: Quick (no finishing pass), Standard (0.2 mm left, then a finishing pass) or Fine (0.3 mm left, 0.2 mm steps on curves).
- **Tool table and cutting values** (folded): flute length, flute count, RPM, feed, allowances and safe Z. Edits are saved.

## 4 · Simulate & load

![Simulate & load](docs/4-simulate.jpg)

- **Simulation**: the stock is cut move by move. Red marks a cut into the part; orange marks material left.
- The timeline has one colour per operation. Change the speed or drag the slider to scrub.
- **Pre-flight checks**. These **block loading** when they fail:
  - the tool cuts into the part;
  - a rapid move goes through material;
  - a cut is deeper than the flute;
  - a tool has changed in ncSender;
  - the job doesn't fit the machine travel;
  - a G-code line grblHAL would reject.

  These are **warnings**: straight plunges, speeds or feeds over the limits, material left uncut, and planning notes.
- **Setup sheet**: the face up, the face toward you, the stock size, and the zero.
- **Load into ncSender**, **Save to File Manager** (`AutoCAM/` folder) or **Download**.

![Toolpaths and live machine check](docs/5-toolpaths-live.jpg)

**Machine setup · live** reads ncSender every second and shows:
- whether ncSender is on G54;
- where G54 zero is;
- whether the job fits the soft limits with that zero;
- where the spindle is, also as a red marker in 3D;
- for setup 2, whether you zeroed again after turning the block over.

## How the toolpaths work

| Step | What it does | Tool |
| --- | --- | --- |
| Face the top | Skims the stock top, stepping over 60% of the diameter | surfacing tool, else the largest end mill |
| Rough out | Z-level offset clearing: ramps in, links passes at depth, stops on every floor | largest end mill that reaches the depth (or your choice) |
| Finish walls | Climb-milled wall contours. Only the stretches that change from one level to the next get their own pass; straight walls are finished once from the lowest level, over the full flute. | the roughing tool |
| Clean up corners | Rest roughing where the big tool can't get in | largest smaller end mill that fits |
| Finish corners | Finishes only what the big tool couldn't reach | the corner tool |
| Spot drill, Drill | Peck drilling; through holes go 1 mm past | V-bit; drill matching the hole size |

Holes with no matching drill are milled. An end mill needs 10% of its diameter free on each side to count as fitting.

**Two setups.** Roughing clears a moat around the part and leaves a frame (6 mm by default) for the vise.
- Setup 1 cuts down to the split depth.
- Turn the block over, clamp the frame, and zero again at the same point.
- Setup 2 faces the other side and cuts up to meet setup 1, leaving a 0.5 mm web that holds the part.

## Limits

- 2.5D only: the part is machined from the top, and from the bottom with two setups. Sides are not machined.
- Slopes and curves are finished as 0.2–0.5 mm steps with flat end mills; there is no ball-nose finishing yet.
- No holding tabs.
- Holder and collet collisions are not checked.
- Feeds and speeds are starting values for a hobby machine.
- Air-cut first.

## Files

| File | What it is |
| --- | --- |
| `config.html` | the UI |
| `lib/autocam-engine.js` | CAM engine |
| `lib/autocam-worker.js` | background worker |
| `lib/autocam-sim.js` | simulation and checks |
| `lib/three.min.js` | three.js r159 (MIT) |
| `lib/clipper.js` | Clipper (Boost) |
| `lib/occt-import-js.*` | OpenCascade STEP reader (LGPL-2.1, see `licenses/`) |
