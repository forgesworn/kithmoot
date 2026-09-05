# Choosing a task model

Type `^` in the message composer to see the models enabled for a clerk in
the room. Type part of the shortcut to filter it, then select with the arrow
keys and Enter or Tab, or tap the row. Selection inserts the clerk's name
and shortcut, for example:

```text
@Tally ^astra review this PR
@Tally ^opus5 draft the implementation plan
```

Add the task before sending. A leading shortcut applies to that message's
task; it does not change the clerk's ordinary chat model. Use one leading
shortcut per message. Carets inside the task body, code and quoted examples
remain plain text. Typing a complete shortcut without an agent name can
address the sole matching clerk; with several matches, choose the clerk
from the menu.

The list comes from a live clerk's own signed control-channel catalogue.
KithMoot has no built-in list of model names or providers. An absent clerk,
an ambiguous display name or a withdrawn model cannot be selected for
sending. A host's menu is its declared enabled set; account access still
needs checking by that host.

## Publishing a menu from a stdio brain

The host sends this command to its KithMoot child:

```json
{
  "op": "announce",
  "agents": [{
    "id": "tally", "name": "Tally",
    "models": [{ "id": "astra", "label": "Astra" }, { "id": "opus5", "label": "Opus 5" }]
  }],
  "running": [{ "id": "tally", "name": "Tally", "participant": "<clerk's 64-hex public key>", "since": 1 }]
}
```

The child binds the announcement to its own participant key. A selectable
menu must describe that same present agent, using its actual roster name.
The browser does not accept another host's claim to a participant's models.
Separate hosts that launch other agents keep their normal invite catalogue;
they do not yet supply model shortcuts through this self-announcement path.

At most eight unique shortcuts may be advertised per entry. IDs use up to
32 lowercase letters, digits, underscores or hyphens, starting with a letter
or digit. Labels are single-line text up to 64 characters. The enclosing
control message still obeys the 2,000-character chat limit.

Re-announce on arrival, when the list changes and in response to
`catalogue?`. The host maps the plain-text selector to its exact task runtime
and applies its normal sender permissions and approval policy. Neither the
catalogue nor the selector grants extra authority or verifies a model run.
Unknown shortcuts must be reported without substituting another model.
