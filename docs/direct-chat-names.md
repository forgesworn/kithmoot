# Personal names for direct chats

A two-person identity policy identifies a direct chat. A group with two people
present keeps its shared group name.

Direct chat titles use this person's personal label, then the other person's
public profile or room roster name. A saved legacy name is an offline fallback;
a fallback matching this person's own profile is ignored. Verified counterpart
names still work when both people happen to use the same name. Chat list and
open-chat titles follow the same rule.

Room info → Name and picture offers Save name for me and Use their name.
Neither action publishes a room rename or changes what the other person sees.
The optional `room.chatLabel` field travels inside the existing NIP-44 encrypted
account bookmark, using the same format on web, desktop and Android. Resetting
omits that field from the new record, so another current device drops its copy.
Local room refreshes preserve a label. As with other bookmark edits, simultaneous
changes use the existing record ordering. An older client can drop an unknown
field when it next rewrites a bookmark; update all devices for reliable labels.

Group rename controls and their shared control-channel operations are unchanged.
Public profile visibility and existing sign-in/network choices remain in force.
No new service or operator access is introduced.
