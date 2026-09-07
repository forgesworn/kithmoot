# KithMoot and Slack: UX benchmark — 7 September 2026

The pass has improved navigation, catch-up, room switching, drafts, search,
invitations, confirmations, shared work and phone reading space. Those are
verified improvements to KithMoot. They do not establish that people work
faster or make fewer mistakes here than in Slack.

The original question deserves a concrete benchmark, rather than treating
visual polish or a green browser suite as proof of superiority.

| Journey | Slack's documented behaviour | Current KithMoot evidence and gap |
| --- | --- | --- |
| Move through a busy workspace with the keyboard | Section shortcuts, arrow navigation between messages, and shortcuts for unread messages and message actions. [Keyboard navigation](https://slack.com/help/articles/115003340723-Navigate-Slack-with-your-keyboard). | KithMoot now has Control/Command+F6 section navigation, arrows and Home/End for loaded messages, Enter or Shift+F10 for message actions, and an app shortcut-help dialog. Browser journeys cover drafts, hidden sections, read-only conversations and focus through updates. This addresses the identified navigation gap; it does not establish equivalent screen-reader or physical-device acceptance. |
| Find earlier work | Search supports modifiers for people, conversations and dates, plus filters for different result types. [Search in Slack](https://slack.com/help/articles/202528808-How-to-search-in-Slack). | KithMoot searches loaded, decrypted messages across the current room, with conversation and file filtering. Its coverage is stated in the UI. That is useful local discovery; it is not equivalent to searching an organisation's archive. |
| Follow a discussion within a busy conversation | Threads have their own view, unread replies and notification controls; a thread can open in another desktop window. [Slack threads](https://slack.com/help/articles/115000769927-Use-threads-to-organize-discussions). | KithMoot renders inline replies and retains reply context and drafts. Search can find edited replies and return to their conversation. A dedicated followed-thread workflow is not established by those checks. |

KithMoot's conversation-to-work journey is a promising focus: create a room,
invite someone, discuss the work, assign it, answer a question, review evidence
and accept the exact result. `test/assignments.spec.ts` exercises that journey
with two independent browsers. The agent list also exposes advertised actions
directly, preparing an assignment without overwriting an unfinished draft.
Its browser journey covers invitation through explicit result acceptance.
This is an assessment of where to focus, not a claim that Slack cannot support
a comparable workflow or that the fixture executed an external agent job.

The next useful comparison is the same set of tasks in both applications:
join a room, find a decision, return after an interruption, reply within a
discussion, and complete a reviewed assignment. Record completion, wrong-room
actions, lost work, navigation effort and user preference. That comparison
would support a competitive usability claim; browser automation alone does not.

The implementation and browser evidence are recorded in the
[UI/UX pass](ui-ux-pass-2026-09-07.md). Source inspection for this comparison
covered `app/src/main.ts`, `app/src/conversation-search.ts`,
`app/src/message-actions.ts` and the workspace, search and assignment journeys.
Slack's documentation above was checked on 7 September 2026; it is a documented
behaviour comparison, not a hands-on Slack test or an accessibility certification.
