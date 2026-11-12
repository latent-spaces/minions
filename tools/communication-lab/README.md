# Communication connector lab

Run `npm run communication:lab` from the repository root. `MLSWARM_LAB_PORT`
optionally selects a port; otherwise it prints a free loopback URL. Ctrl-C stops it.

The lab imports the production CommunicationMap with four synthetic characters.
Rubber tube is selected by default. Other straight connector styles remain in
View for comparison. No API proxy, login, participant writes or model invocation.

Initial messages are already one minute old. New sample messages are off by
default: the retained pipes replay visual pulses even without new sends. Toggle
New sample messages to add synthetic events every four seconds, or press Send
sample message once. Pause stops visual motion and the local clock.

Selected tubes are dark charcoal-violet (#352b3d fill, #211b27 outline), held
at 88–96% opacity with a faint glint so old pipes remain clearly visible. They
are thin (1.6px resting radius, 0.9px outline), with round ends,
a compact 3.2px traveling swell and a small warm bead. Visible connections last
three minutes; physical attraction retains the original 45-second lifetime.
Visual replay repeats every 3.6 seconds per pair and never creates an avatar
message acknowledgment. Reduced motion removes traveling passes.

Hover or keyboard-focus a pipe to see its latest message: whitespace collapsed,
160 Unicode characters plus ellipsis. The hover card stays usable when moving
onto its Open conversation link. In this synthetic lab that link reports the
selected sample ID; in the app it opens the real conversation at that message.
The app loads preview text on demand through its existing authorized reader,
without putting message bodies into metadata or layout workers.
