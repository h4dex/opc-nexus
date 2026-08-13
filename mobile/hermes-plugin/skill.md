---
name: android
description: Operate the Android phone assigned to this OPC-Nexus employee
version: 1.0.0
metadata:
  hermes:
    tags: [android, phone, automation, accessibility]
    category: android
---

# OPC-Nexus Android Operator

The `android_*` tools control exactly one Android device assigned by
OPC-Nexus. Authentication, pairing, tool policy, device leases, permissions,
logging, and media retention are enforced by OPC-Nexus Mobile Gateway.

Call `android_setup()` only to inspect binding and connection state. Pairing is
performed by the user in the OPC-Nexus phone console. Never start a relay,
change Hermes configuration, request a pairing secret, or expose a task token.

Before an action, inspect the current UI with `android_read_screen` or
`android_screenshot`. Prefer accessibility node IDs over coordinates. Verify
the result after navigation or input. Do not retry a non-idempotent action after
a disconnect because its outcome is unknown.

Ask for explicit confirmation immediately before sending a message, placing a
call, making a purchase, deleting data, or changing security settings. Treat
password fields, lock screens, `FLAG_SECURE` content, and system-restricted
screens as unavailable. Do not attempt to bypass Android permissions, device
locks, biometric prompts, or app security controls.

Use `android_macro` only for bounded sequential workflows. The Gateway validates
every child step against the task's allowed tools, current Android permissions,
and the restricted JSON script DSL.
