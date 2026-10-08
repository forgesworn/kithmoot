# Room navigation and lifetime controls

Private two-person conversations show the other participant's verified kind-0 picture in the room list when public profile lookup is enabled. Ordinary rooms keep their room initial. Turning profile lookup off removes these pictures. MySignet contact photos remain pending a granted contact-photo field.

The desktop masthead and workspace brand return to the start page through the existing navigation path, including preserving a docked call and respecting pending work.

Temporary rooms offer Choose a duration with separate days, hours and minutes sliders, up to 30 days. The preview states the end time; zero cannot create a temporary room. Self-destruct and read-only expiry retain their existing signed policy and cleanup rules.

Room opening no longer spends the full 1.5-second encryption settling budget after every configured read relay finishes replaying rekeys. All replayed rekeys are checked before roster publication. A silent relay retains the previous bounded wait. A desktop room watcher created before its first visit is refreshed after joining, so the device and seal keys are available for background rekeys after switching away. Android also obtains the opening label from the home-screen summary rather than decrypting and validating the saved-room vault on the UI thread before opening it again on the worker.

Validation: browser avatar privacy and duration/home journeys passed in Chromium and the desktop fixture; all 13 Chromium room-switch/call-dock journeys passed, including live audio through the brand navigation. The 53 focused session-epoch and relay-pool tests passed, including completed replay, missing completion and recovery without publication under a departed epoch. The previously failing Firefox background-rekey journey passed after refreshing that watcher. Native checks and final release/public-device verification are recorded separately in the Android release notes and publication receipts.
