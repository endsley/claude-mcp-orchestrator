# Claude Agent worker fixture

This intentionally small repository is the only target for the first live
Claude Agent smoke test. A worker may read `src/message.js`, make a controlled
trivial edit, and run `npm test`; production projects must never be used for
that first autonomous check.
