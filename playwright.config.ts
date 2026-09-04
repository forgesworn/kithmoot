import { defineConfig, devices } from '@playwright/test'

// Config for the single acceptance E2E spec (test/e2e.spec.ts). Deliberately
// separate from vitest: it drives a real built app in a real browser against
// live public relays, which vitest.config.ts's node environment cannot do,
// and it must stay out of `npm test` for the same reason test/live.test.ts
// does - real network, real relay weather, not something every `npm test`
// run should pay for or be flaky because of.
export default defineConfig({
  testDir: './test',
  // Three specs, and they are very different animals. e2e.spec.ts drives real
  // public relays and inherits real relay weather. effects.spec.ts needs no
  // network at all: it points Chromium's fake camera at a generated scene
  // and measures the pixels that come back out. relay-capability.spec.ts
  // needs no network either - four peer connections inside one page - and
  // answers the one question feature detection cannot: whether this browser
  // will actually carry somebody else's encoded frames. peer-assist.spec.ts
  // is the same kind of animal one level up: it measures which path carried a
  // pair, what happens when the volunteer shuts its laptop, and what carrying
  // two pairs costs the person doing it. media.spec.ts is the acceptance test
  // for the only question a person in a room actually asks - can I see you,
  // can I hear you - measured off the decoded pixels and the audio energy,
  // and it lives beside e2e.spec.ts because it needs the same real relays.
  // rooms.spec.ts is the front page: the rooms this device has been in,
  // with what is new and who is here read off the relays without joining.
  // verification.spec.ts is the one question the unit tests cannot answer:
  // whether the word on one person's screen is the word the other is waiting
  // to hear. Two independent browsers, or it proves nothing.
  // speaking.spec.ts checks that the tile lights for real audio and, more
  // importantly, goes dark again on mute - an analyser that is never pulled
  // reports silence for ever with nothing in the console, so this feature
  // can fail by simply never happening.
  testMatch: ['e2e.spec.ts', 'media.spec.ts', 'soak.spec.ts', 'agent.spec.ts', 'effects.spec.ts', 'relay-capability.spec.ts', 'peer-assist.spec.ts', 'rooms.spec.ts', 'speaking.spec.ts', 'verification.spec.ts', 'channels.spec.ts', 'chat-reliability.spec.ts', 'updates.spec.ts'],
  // Public relays take a few seconds to round-trip a roster event, and the
  // join-last case waits on three of those in sequence: A's entry, B's, and
  // then A and B answering C's arrival. The stage-1 live test used similar
  // multi-second settle windows; this is deliberately generous, because the
  // answer to a slow relay is patience, not a weaker assertion.
  timeout: 180_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  // One spec at a time, across files as well as within them.
  //
  // `fullyParallel: false` only serialises the tests inside a file; the files
  // themselves still went to one worker per two cores. Each of these specs
  // drives two or three real browsers, each decoding video and each running
  // the segmentation pipeline for its own camera, so two specs at once is six
  // of those on a four-core runner. Oversubscribing it does not buy anything:
  // measured here, the whole suite took 10.6 minutes on two workers and 4.5
  // on one, because the contention was the slow part. Whatever is left over
  // goes to the 90-second polls, which is the difference between a picture
  // that is late and one that is missing.
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: {
    // Carries the `/j/` sub-path the app is published under (see the `base`
    // in app/vite.config.ts) - `vite preview` serves nothing at the root.
    baseURL: process.env.E2E_BASE_URL ?? 'https://localhost:4173/j/',
    // app/vite.config.ts's basicSsl() plugin runs under `vite preview` too,
    // so the app is only ever reachable here over a self-signed cert.
    // Irrelevant to getUserMedia's secure-context check either way -
    // localhost is a secure context regardless of certificate validity -
    // but the browser still needs telling not to block the navigation on it.
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'firefox',
      testMatch: ['chat-reliability.spec.ts'],
      use: { ...devices['Desktop Firefox'] },
    },
    {
      name: 'webkit',
      testMatch: ['chat-reliability.spec.ts'],
      use: { ...devices['Desktop Safari'] },
    },
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: [
            // Grants camera/mic with synthetic media and no permission
            // prompt - there is no human present to click "Allow".
            '--use-fake-device-for-media-stream',
            // A fake audio sink with a real-time clock. Without it every
            // AudioContext is clocked by the machine's output device, and a
            // device that is asleep or stalled - seen on a Mac mini - leaves
            // the microphone pipeline producing no samples and WebRTC sending
            // no audio, which reads exactly like an application bug.
            '--disable-audio-output',
            '--use-fake-ui-for-media-stream',
            // Remote audio has to be allowed to actually play. A person
            // clicks "Join room" and that gesture is what permits playback;
            // with no human present the policy has to be lifted explicitly,
            // or an `<audio>` element sits there unplayed - and an audio
            // track with no sink is never decoded, so it reports exactly
            // zero energy and media.spec.ts cannot tell "silent because
            // nothing arrived" from "silent because nothing was played".
            '--autoplay-policy=no-user-gesture-required',
            // The same favour for getDisplayMedia, which otherwise opens a
            // picker no test can answer. Needed by media.spec.ts's screen
            // share case; harmless everywhere else.
            '--auto-accept-this-tab-capture',
            '--auto-select-desktop-capture-source=Entire screen',
          ],
        },
      },
    },
  ],
  // Builds the app and serves app/dist on localhost via `vite preview`,
  // which - like `npm run demo` - runs under app/vite.config.ts's basicSsl
  // plugin, so it's HTTPS with a self-signed cert (see ignoreHTTPSErrors
  // above). Skipped entirely when E2E_BASE_URL points somewhere already
  // running (e.g. a developer's own `npm run demo`).
  //
  // Unless E2E_RELAYS=live (see test/relays.ts) a NIP-01 relay is started
  // beside it - test/ws-relay.mjs - and the specs pin every room to it. That
  // is the CI configuration: the same acceptance tests, no public relays,
  // no weather. Unset, the specs run against the app's real default relays.
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : [
        {
          command: 'npm run build && npx vite preview --config app/vite.config.ts --port 4173 --strictPort',
          url: 'https://localhost:4173/j/',
          ignoreHTTPSErrors: true,
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
        },
        ...(process.env.E2E_RELAYS !== 'live'
          ? [
              {
                command: 'node test/ws-relay.mjs',
                url: 'http://127.0.0.1:7777/',
                reuseExistingServer: !process.env.CI,
                timeout: 30_000,
              },
            ]
          : []),
      ],
})
