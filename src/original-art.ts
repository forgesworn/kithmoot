/** Original KithMoot artwork: local picker access needs no membership or network lookup. */
export const ORIGINAL_EMOJIS = [
  [
    ":km_laugh:",
    "laugh laughter lol funny tears"
  ],
  [
    ":km_facepalm:",
    "facepalm not again frustrated head wall"
  ],
  [
    ":km_mindblown:",
    "mind blown shocked wow surprise"
  ],
  [
    ":km_cool:",
    "cool sunglasses smug deal with it"
  ],
  [
    ":km_shrug:",
    "shrug whatever dunno unsure"
  ],
  [
    ":km_celebrate:",
    "celebrate party yes victory confetti"
  ],
  [
    ":km_angry:",
    "angry furious rage fuming"
  ],
  [
    ":km_love:",
    "love heart hug thanks affection"
  ],
  [
    ":km_cry:",
    "cry sad tears sob upset"
  ],
  [
    ":km_sideeye:",
    "side eye unimpressed sceptical doubt"
  ],
  [
    ":km_popcorn:",
    "popcorn drama watching waiting"
  ],
  [
    ":km_micdrop:",
    "mic drop winner done nailed it"
  ],
  [
    ":km_thumbsup:",
    "thumbs up approve yes good thanks"
  ],
  [
    ":km_thumbsdown:",
    "thumbs down no dislike nope"
  ],
  [
    ":km_slowclap:",
    "slow clap sarcastic applause brilliant"
  ],
  [
    ":km_eyeroll:",
    "eye roll bored annoyed unbelievable"
  ],
  [
    ":km_waiting:",
    "waiting impatient time clock hurry"
  ],
  [
    ":km_exhausted:",
    "exhausted dead tired done sleepy"
  ],
  [
    ":km_wtf:",
    "wtf what confused baffled huh"
  ],
  [
    ":km_melting:",
    "melting embarrassed cringe awkward"
  ],
  [
    ":km_plotting:",
    "plotting evil cheeky grin mischievous"
  ],
  [
    ":km_moon:",
    "moon rocket fly launch to the moon"
  ],
  [
    ":km_coffee:",
    "coffee tired morning wake caffeine"
  ],
  [
    ":km_handshake:",
    "handshake agree deal friends respect"
  ]
] as const
export function isOriginalEmoji(value: unknown): boolean { return ORIGINAL_EMOJIS.some(([code]) => code === value) }
