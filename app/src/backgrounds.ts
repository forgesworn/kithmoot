export interface BackgroundChoice {
  id: string
  label: string
  /** A still picture under `app/public/`. Fetched when the choice is picked
   *  and not before: the coral photograph is 167KB and nobody who leaves the
   *  blur on should ever pay for it. */
  url?: string
  /** Underwater, so the fish have somewhere to be. The switch that puts them
   *  there is only offered on these. */
  sea?: true
}

/** What you can put behind yourself. */
export const BACKGROUNDS: BackgroundChoice[] = [
  { id: 'slate', label: 'Slate', url: 'backgrounds/slate.svg' },
  { id: 'ember', label: 'Ember', url: 'backgrounds/ember.svg' },
  { id: 'fen', label: 'Fen', url: 'backgrounds/fen.svg' },
  { id: 'sea-lagoon', label: 'Lagoon', url: 'backgrounds/sea-lagoon.webp', sea: true },
  { id: 'sea-coral', label: 'Coral garden', url: 'backgrounds/sea-coral.webp', sea: true },
  { id: 'sea-deep', label: 'Deep blue', url: 'backgrounds/sea-deep.webp', sea: true },
  { id: 'sea-sand', label: 'White sand', url: 'backgrounds/sea-sand.webp', sea: true },
]
