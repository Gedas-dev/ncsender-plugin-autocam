# AutoCAM for ncSender

STEP file to G-code inside ncSender. Open a part, pick the side that faces up, and AutoCAM does the rest:

1. It finds the pockets, holes and outline.
2. It checks which tools are loaded in ncSender: the tools `M6 T<n>` can reach (`/api/tools/active`), in Slot or Tool ID numbering.
3. It picks the tools and plans the toolpaths, in one or two setups.
4. It loads the program straight into ncSender.

The window fills the screen and scales its text with it, so it stays readable on a big monitor.

Everything runs in the ncSender window, with nothing else to install:
- the STEP file is read by OpenCascade compiled to WebAssembly;
- the 3D view uses three.js;
- the planning runs in a background worker, so ncSender stays responsive.

## Install

ncSender → **Settings → Plugins → Install Plugin → ZIP** → choose `ncsender-plugin-autocam.zip` → **Install from File**, then **Enable**.
To run it, open the **Plugins** tab in the console area and press **AutoCAM**.

## The four steps

1. **Model.**
   - Drop a `.step`/`.stp` file onto the viewer, or choose one. The 3D view colours pockets, holes and the outline: drag to rotate, scroll to zoom, right-drag to pan.
   - **Which side faces up?** Each side shows **Best**, **Reachable**, **2 setups** or **Can't reach**. Hover a side to see why: how much overhangs hide, and whether the part is taller than the longest flute.
   - AutoCAM picks the side for you when the file opens:
     - the side that reaches everything in one setup, preferring the lowest part;
     - if no side does, the side whose two setups (it, then turned over) reach the most, and it switches on **Two setups**;
     - parts that would stand taller than 40% of the Z travel ($132) are ranked down.
   - It also turns the part on the table so its long side runs along the machine's long axis (X on most machines). **↻ Turn 90°** turns it a quarter turn.
   - You can also click any flat face on the model to put it on top.
   - **How it sits on the table** says which model face is up, which faces you, and the size along X, Y and Z. The 3D view marks the front (**FRONT · YOU**) and the X/Y/Z directions.
   - **Found in this part** lists the pockets (and whether they go through), holes grouped by diameter, and the outline.
2. **Stock & zero.**
   - **Material:** pick a card (aluminium, wood / MDF, plastic, brass, mild steel). It sets the speeds, feeds and depth of each pass.
   - **Stock block:** margin each side and the stock above the part. The 3D view shows the block.
   - **Where is zero?** Nine points: the four corners, the middle of each edge, or the centre. Click a dot on the stock in the 3D view or on the small top view. **Z0 on stock top** or **Z0 on the bed** (the stock bottom).
   - **Setups:** one, or two with the part turned over (see below).
3. **Operations** ("Here's the plan").
   - AutoCAM plans in the background as soon as the step opens and shows one row per operation: **Flatten the top**, **Clear the material**, **Clean out corners**, **Finish the walls**, **Spot the holes**, **Drill N holes Ø…**. Each row shows its speed, feed and time, and which setup it runs in.
   - Choose the tool for flattening, clearing and the corners (or leave it on Auto), and switch any operation off except clearing. With drilling off, holes are milled instead; with finishing off, clearing cuts the walls to size.
   - **Finish:** **Fast** (no finishing pass), **Balanced** (0.2 mm left for a finishing pass) or **Smooth** (0.3 mm left, 0.2 mm steps on slopes and curves).
   - **Tools for this job** lists the tools the plan uses and which one is in the spindle.
   - **Tool table and cutting values** (folded away):
     - the tools loaded in ncSender; untick one to keep the plan from using it;
     - flute length and flute count, read from the tool library or the tool name ("Single Flute 1/4 6mm 22mm"); type over them if needed;
     - RPM and feed, calculated from the material and your spindle and feed limits (`$30`, `$31`, `$110`, `$111`). Any field can be overridden, and edits are saved;
     - finish allowance, leave at bottom (negative cuts into the spoilboard to go through), safe Z, ramp angle, slope step.
   - The 3D view shows the planned toolpaths.
4. **Preview & load.**
   - **Toolpaths:** toolpaths in 3D over the part, with a stock box and the zero marker.
   - **Simulation:** the stock block is cut away move by move, with the tool shown as it moves. Play or pause, or drag the slider; it shows the operation, the tool and the time. Red shows a cut into the part; orange shows material left uncut.
   - The slider's track has one coloured band per operation, in the operation's toolpath colour; what is still to come is dimmed.
   - **Pre-flight checks** run on every setup before Load is allowed (see below).
   - **Setup sheet**: the face up, the face toward you, the stock size, where to zero G54 and, for setup 2, how to turn the block over.
   - **Machine setup · live**: see below.
   - An operations list with a show/hide toggle per operation, and times.
   - **Load into ncSender**, **Save to File Manager** (it saves to the `AutoCAM` folder) or **Download**. With two setups, a tab per setup.

## Pre-flight checks

The simulation runs in the background as soon as the toolpaths are ready. Load stays disabled until it has finished.

| Check | If it fails |
| --- | --- |
| The tool never cuts into the finished part | blocks loading |
| No rapid (G0) move goes through uncut material | blocks loading |
| No cut is deeper than the tool's flute length | blocks loading |
| Every tool used is still in ncSender's tool table, with the same diameter | blocks loading |
| The program's X, Y and Z extents fit the machine travel ($130–$132) | blocks loading |
| Every line is G-code grblHAL accepts (plain ASCII, no nested brackets in comments) | blocks loading |
| No end mill plunges straight down into solid material | warning |
| Speeds and feeds within $30, $31 and $110–$112 | warning |
| Material left uncut, with the size, height and position of each area | warning |
| Notes from planning | warning |

You can still load a program with failed checks: tick "I've checked these problems and want to load anyway".

## Machine setup · live

On **Preview & load**, AutoCAM reads ncSender's machine state every second and checks the real setup against the program:

| Check | Shows |
| --- | --- |
| Work offset | ✗ if ncSender is on G55–G59; the program uses G54 |
| G54 zero | where G54 zero is, in machine coordinates |
| Travel with this zero | ✗ if the job would run past a soft limit, for example "X goes to 1353.1, 92.1 mm past the X+ limit (1261)". Needs the machine homed. Z uses the tool in the spindle now. |
| Spindle position | where the spindle is from the zero, and whether it is over the stock. A red marker in the 3D view shows it: jog to the zero corner and the marker should sit on it. |
| Setup 2 zero | ⚠ if G54 hasn't changed since setup 1 was loaded (AutoCAM remembers the zero when you load a setup) |

The machine envelope comes from `$130`–`$132` with the homing settings `$22` and `$23`.

Each program's header also says how the part sits: `(PLACEMENT: model Top [+Z] face up, model Front [-Y] face toward you)`.

## What it generates

| Order | Operation | Tool choice |
| --- | --- | --- |
| 1 | Flatten the top (face the stock) | surfacing tool, else the largest end mill |
| 2 | Clear the material: Z-level offset roughing; ramps along the path, links between passes at depth, stops on every floor | your choice, or the largest end mill that reaches full depth and gets to at least 90% of the material |
| 3 | Clean out corners: rest roughing of slots and corners the roughing tool can't get into | largest smaller end mill that gets into them, within its flute length |
| 4 | Finish the walls: climb milling, with lead-ins from the roughed-out area | rest tool where it reaches, roughing tool below |
| 5 | Spot the holes | chamfer / V-bit |
| 6 | Drill the holes: peck drilling; through holes go 1 mm past the bottom | drill matching each hole's diameter |

Holes without a matching drill are milled as pockets, if an end mill fits.

Milling never goes deeper than the longest end mill's flute length. Holes that open from below are not machined from the top.

An end mill only counts as fitting a pocket or hole if it has 10% of its diameter free on each side. Otherwise it would have to plunge straight down like a drill. A Ø6.2 hole therefore goes to a 4 mm end mill, not a 6 mm one.

Bands with sloped or curved walls get a finishing contour every 0.5 mm, so the steps left on chamfers and fillets stay small.

## Two setups (turn the part over)

On **Stock & zero**, pick *Two setups, turn over front to back* (flip about X) or *left to right* (flip about Y). Generate then gives two programs; switch between them with the **Setup 1 / Setup 2** tabs above the 3D view. **Load setup N into ncSender** loads the one on screen, and **Save both to File Manager** saves both.

- **Frame.** Roughing clears only a moat (largest end mill + 1 mm) around the part. A frame of stock (default 6 mm) is left at full height around the moat, and the stock margin grows to fit it. The vise holds the frame in both setups.
- **Setup 1** works from the top, down to the split depth. By default that's half the part height, limited to the longest flute; set **Setup 1 depth** to choose it.
- **Setup 2:** turn the block over about the chosen axis, clamp the frame, and zero G54 again on the turned-over block, at the same zero point. This setup faces the stock below the part, then machines up to where setup 1 stopped.
  - Inside the part outline it goes 0.2 mm past, so pockets and holes break through.
  - In the moat it stops a **web** (default 0.5 mm) short, which keeps the part attached to the frame. Cut or snap it free afterwards and deburr.
  - Holes drilled or milled in setup 1 are not machined again.
- Each program's header says which setup it is and how to clamp and zero it.

The program is plain grblHAL G-code in mm (`G21 G90 G94 G17 G54`).
- Tool changes are written as `M6 T<n>`. Your ncSender tool changer handles them (Manual Tool Changer, Rapid Change ATC and so on).
- Work zero is the point you chose on the stock: top or bottom, at a corner, an edge middle or the centre.

## Limits

- 2.5D prismatic parts only: Z up, machined from the top, plus the bottom in an optional second setup. Sides are not machined.
- Sloped or curved surfaces and rounded edges are finished in 0.5 mm steps with flat end mills. They are never gouged, but there's no ball-nose or chamfer finishing yet.
- No holding tabs yet. For a through-cut, hold the part down with screws, vacuum or tape.
- The simulation of setup 2 starts from a full stock block; it doesn't carry over what setup 1 cut.
- Tool holder and collet collisions are not checked; only flute length is.
- Feeds and speeds are starting values for a hobby-class machine. Check them against your tool maker's data.
- Air-cut first. Check the toolpath in ncSender's visualizer before running a job.

## Files

- `config.html`: the UI (a ncSender tool-menu dialog: the wizard and 3D viewer)
- `lib/autocam-engine.js`: CAM engine (mesh slicing, features, reachability, tool selection, toolpaths, post)
- `lib/autocam-worker.js`: runs analysis, planning and simulation off the UI thread
- `lib/autocam-sim.js`: stock simulation (height map) and the pre-flight checks
- `lib/three.min.js`: three.js r159, MIT licence
- `lib/clipper.js`: Clipper polygon library, Boost licence
- `lib/occt-import-js.*`: OpenCascade STEP reader for the browser, LGPL-2.1 (see `licenses/`)
