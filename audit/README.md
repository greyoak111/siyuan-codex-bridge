# SiYuan bridge audit

The local STDIO bridge writes `operations.jsonl` here when an official MCP
action is allowed or denied. Each line contains only a timestamp, the active
profile, the aggregate tool name, the action name, and the decision.

The audit stream deliberately omits arguments, note content, response bodies,
request headers, and the SiYuan API token. The file is created with mode 600
and is ignored by git. It is useful for reviewing which operation level was in
effect without turning the audit log into a copy of the workspace.
