# Map review lab

Run `npm run communication:lab`. `MINIONS_LAB_PORT` optionally sets its port.

The root URL shows the expanded map and a 390 × 844 phone viewport side by side.
Both receive one shared synthetic clock, participant roster and message stream.
Pause and Send sample message control both panes. No scaling is applied: narrow
windows scroll horizontally. The expanded pane uses its measured available width;
it does not pretend to be a laptop-sized browser. Its Full screen action uses the
browser fullscreen API for a whole-window 1:1 check. Embedded footers report actual
viewport and map sizes. The phone uses production side-panel CSS.

Use map bounds is the initial lab selection: project the layout into each map's
actual usable rectangle, with gutters for fixed-size portraits, state bubbles and
names. People use a 50px portrait against 40px agent portraits; their ring,
hit area and connector mask scale with them while label type stays 12px.
Both axes fill independently; distances and angles are presentation-only.
Colliding labels lose all text including names; details remain on inspection.
This is the selected product behavior, shared with the lab. Manual zoom
and pan still operate on the projected coordinates; Fit map returns to the bounds.

Use map bounds uses production CommunicationMap with focus-active crowding, its actual
worker, movement, camera and connectors. The label treatments are lab-only
label presentation proposals: names first, collision-aware names, details on tap.
All retain hover, tap and keyboard agent inspection. Previous layout explicitly
turns off normalization to compare the older presentation.

Messages send every four seconds while playing. Connection previews open synthetic
conversation history. No live data, API calls, authentication or model execution.
The shell and toolbar are simplified fixtures, not the authenticated application.
