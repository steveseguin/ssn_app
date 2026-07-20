# Resources Folder Notes

## `social_stream_fallback` is disposable

`resources/social_stream_fallback` is not the primary source of the app.

- It is a **bundle mirror** generated for packaged/distributed builds.
- It is **rebuilt on every build/update**.
- Do **not** modify it as part of normal app work.

For source changes, always work in:

- `C:\Users\steve\Code\social_stream`
