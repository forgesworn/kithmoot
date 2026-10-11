# Room history when browser storage fails

Room switching retains a bounded session copy of original signed,
room-encrypted events even when the browser refuses encrypted archive storage.
It holds at most 64 conversations, 500 events per conversation and 8 MiB of
serialised event data altogether. Least recently used conversations and oldest
events are evicted. The durable archive retains its existing separate limits.

This cache does not survive closing the document. It does not replace the
archive, export its non-extractable keys, store decrypted messages or mark a
failed disk write as successful. Later copies still retry durable storage.
Reads preserve original event identifiers, timestamps, cursors and quiet-room
restrictions. Quiet events remain excluded from relay reseeding. Forgetting a
conversation immediately drops its session copy and refuses late keeps while
disk deletion is pending; a failed disk deletion still rejects the operation.
Forgetting the browser reloads the document after deleting its archive.

After a storage failure, Room details explains that some history was not saved
and that closing the app may require recovering messages from another member
or a relay. The notice remains accurate if subsequent writes recover: some
earlier history may still be absent from disk.

On 11 October, the M4 qualification session refused IndexedDB writes of both
non-extractable AES-GCM and HMAC keys with `DataCloneError`. The same bounded
probe succeeded in Chromium. A keychain settings query also returned “User
interaction is not allowed”. These observations do not establish a general
Safari limitation. Durable WebKit recovery must be qualified separately from
the session-cache fallback.

Six focused browser journeys pass in Chromium, Firefox and WebKit, including
deliberately refused key writes, delayed relay history, independent reading
positions, unread counts, Jump to latest and the visible storage explanation.
Unit coverage also checks bounds, quiet duplicates, deletion during failure
and retrying durable writes without treating the cache as persisted.
