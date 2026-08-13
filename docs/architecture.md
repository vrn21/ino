# Architecture

```
client --HTTP polling--> Worker router --> CodingSession Durable Object
                                    \--> GitHub API (optional token)
CodingSession --ephemeral BYOS key--> Modal launch bridge --> Codex container/VNC
```

The Worker only routes typed JSON APIs. A unique Durable Object ID is allocated
at session creation and is the stable session ID. Its persisted value is the
complete coordination record: lifecycle status, selected repository, initial
prompt, capped event list, timestamps, optional Modal job identifier, and VNC
URL. This provides durable polling with no extra services.

The Modal adapter defaults to mock mode. Its remote payload intentionally has a
narrow schema: repository checkout data, `codex exec` command, and one
process-environment variable for the per-session OpenAI key. BYOS credentials
cross the Worker only for that launch call; they are excluded from all DO writes
and responses. The actual Modal bridge is deployment-specific and remains the
trust boundary that provisions checkout/VNC and owns environment teardown. The current MVP contract implements launch only;
its stop endpoint updates durable coordination state but does not yet invoke a
bridge termination operation.
