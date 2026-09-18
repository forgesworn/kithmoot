// The order of precedence between the three panels, at the window sizes the
// owner actually uses. The browser half - that the stylesheet's custom
// properties really do produce these widths - is measured in
// test/desktop-room-layout.spec.ts; this pins the arithmetic they mirror.
import { expect, test } from 'vitest'
import {
  CALL_MIN_WIDTH_PX, CHAT_MIN_WIDTH_PX, CHAT_READING_WIDTH_PX, RAIL_COLLAPSED_PX, WORK_MAX_PX, WORK_MIN_PX,
  callPaneWidth, chatColumnWidth, chatDrawerWidth, chatIsDrawer, roomAreaWidth, workPanelWidth,
} from './desktop-panes.js'

/** The three windows named in the brief. */
const WINDOWS = [{ width: 1320, height: 880 }, { width: 1100, height: 700 }, { width: 1600, height: 1000 }]

test('with Work open and room to spare, Work gets what it asked for', () => {
  expect(workPanelWidth(1600)).toBe(WORK_MAX_PX)
  expect(workPanelWidth(1320)).toBe(WORK_MAX_PX)
})

test('Work is the panel that narrows when the window cannot hold all three', () => {
  // 1280 is where the fixed Work panel appears at all, and it is already
  // 24px short of everybody having what they want.
  expect(workPanelWidth(1280)).toBe(1280 - 208 - 360 - 240 - 48)
  expect(workPanelWidth(1280)).toBeLessThan(WORK_MAX_PX)
  expect(workPanelWidth(1280)).toBeGreaterThanOrEqual(WORK_MIN_PX)
  // And it never disappears into a sliver, however narrow the window gets.
  expect(workPanelWidth(900)).toBe(WORK_MIN_PX)
})

test('collapsing the rooms rail gives its width to Work, not to the gutter', () => {
  expect(workPanelWidth(1280, RAIL_COLLAPSED_PX)).toBe(WORK_MAX_PX)
})

test('the conversation keeps its floor with Work open at every window size', () => {
  for (const window of WINDOWS) {
    const room = roomAreaWidth(window.width, { work: true })
    expect(chatDrawerWidth(room), `${window.width}x${window.height} with Work open`).toBeGreaterThanOrEqual(CHAT_MIN_WIDTH_PX)
  }
})

test('the conversation grows past its floor once there is room for it', () => {
  const room = roomAreaWidth(1600, { work: false })
  expect(chatDrawerWidth(room)).toBeGreaterThan(CHAT_MIN_WIDTH_PX)
  expect(chatDrawerWidth(room)).toBeLessThanOrEqual(WORK_MAX_PX)
})

test('the call pane takes what is left, and the conversation never pays for it', () => {
  // 1280 is the tight case: everybody is exactly on their floor.
  const tight = roomAreaWidth(1280, { work: true })
  expect(chatDrawerWidth(tight)).toBe(CHAT_MIN_WIDTH_PX)
  expect(callPaneWidth(tight)).toBe(CALL_MIN_WIDTH_PX)
  // Narrower still, and it is the call pane that goes below its floor.
  const cramped = roomAreaWidth(1000, { work: true })
  expect(chatDrawerWidth(cramped)).toBe(CHAT_MIN_WIDTH_PX)
  expect(callPaneWidth(cramped)).toBeLessThan(CALL_MIN_WIDTH_PX)
})

test('with nothing beside it the conversation is the main column, not a strip', () => {
  // The window the regression was reported from. A 1744px window left the
  // drawer at about 300px and the middle 1150px black.
  const wide = roomAreaWidth(1744, { work: false })
  expect(chatIsDrawer(false)).toBe(false)
  expect(chatColumnWidth(wide)).toBe(CHAT_READING_WIDTH_PX)
  expect(chatColumnWidth(wide)).toBeGreaterThan(600)
  // And it is not allowed to become a 1500px line either.
  expect(chatColumnWidth(wide)).toBeLessThanOrEqual(CHAT_READING_WIDTH_PX)
})

test('a narrow room gives the main column everything it has', () => {
  expect(chatColumnWidth(616)).toBe(616)
  expect(chatColumnWidth(0)).toBe(0)
})

test('the drawer comes back only when the call pane has something in it', () => {
  expect(chatIsDrawer(true)).toBe(true)
  expect(chatDrawerWidth(roomAreaWidth(1744, { work: true }))).toBeGreaterThanOrEqual(CHAT_MIN_WIDTH_PX)
})

test('with Work shut, the room area is the window less the rail and the gutter', () => {
  expect(roomAreaWidth(1320, { work: false })).toBe(1320 - 208 - 48)
  expect(roomAreaWidth(1320, { work: false, railWidth: RAIL_COLLAPSED_PX })).toBe(1320 - 56 - 48)
})
