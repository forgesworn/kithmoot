# KithMoot and Slack: UX benchmark — 7 September 2026

The pass has improved navigation, catch-up, room switching, drafts, search,
invitations, confirmations, shared work and phone reading space. Those are
verified improvements to KithMoot. They do not establish that people work
faster or make fewer mistakes here than in Slack.

The original question deserves a concrete benchmark, rather than treating
visual polish or a green browser suite as proof of superiority.

| Journey | Slack's documented behaviour | Current KithMoot evidence and gap |
| --- | --- | --- |
| Move through a busy workspace with the keyboard | Section shortcuts, arrow navigation between messages, and shortcuts for unread messages and message actions. [Keyboard navigation](https://slack.com/help/articles/115003340723-Navigate-Slack-with-your-keyboard). | The room picker, conversation tabs, search and app dialogs have browser coverage. The current message log remains a scrolling region with individual controls in the Tab sequence. Section shortcuts and direct keyboard message navigation are a concrete remaining efficiency gap. |
| Find earlier work | Search supports modifiers for people, conversations and dates, plus filters for different result types. [Search in Slack](https://slack.com/help/articles/202528808-How-to-search-in-Slack). | KithMoot searches loaded, decrypted messages across the current room, with conversation and file filtering. Its coverage is stated in the UI. That is useful local discovery; it is not equivalent to searching an organisation's archive. |
| Follow a discussion within a busy conversation | Threads have their own view, unread replies and notification controls; a thread can open in another desktop window. [Slack threads](https://slack.com/help/articles/115000769927-Use-threads-to-organize-discussions). | KithMoot renders inline replies and retains reply context and drafts. Search can find edited replies and return to their conversation. A dedicated followed-thread workflow is not established by those checks. |

KithMoot's conversation-to-work journey is a promising focus: create a room,
invite someone, discuss the work, assign it, answer a question, review evidence
and accept the exact result. `test/assignments.spec.ts` exercises that journey
with two independent browsers. This is an assessment of where to focus, not a
claim that Slack cannot support a comparable workflow.

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
