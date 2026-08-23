# OPC-Nexus v2 Hermes Acceptance Report (2026-08-24)

## Scope

This report records a real desktop acceptance run on the Hermes v2 PR branch. It
used a configured OpenAI-compatible Provider and the pinned Hermes v0.19.0
runtime. No Mock, baseline fallback, fake employee, or synthetic completion was
used.

## Results

| Check | Result | Evidence |
| --- | --- | --- |
| Provider model discovery | PASS | 15 upstream models returned; manual selection persisted |
| Provider connectivity | PASS | `/models` returned successfully and the Provider test passed |
| Quest embedded Workbench | PASS | `open=true`, `attached=true`, `visible=true`; no renderer console errors |
| Hermes runtime | PASS | Dashboard + Gateway reached `healthy/ready`; Hermes `0.19.0` |
| Hermes UI | PASS | `/chat`, `zh-CN`, Chinese locale, dark theme, visible composer |
| Simple request | PASS | Returned through the real Hermes API Server |
| Queued turns / streaming | PASS | Two same-session turns were accepted before completion; WebSocket deltas observed |
| Dynamic employee dispatch | PASS | `@数字员工` created a real governed task and a verified artifact |
| Complex project delivery | PASS | Research and implementation employees completed; preview, manifest, and desktop/mobile screenshots were real |
| Independent acceptance | BLOCKED | The reviewer found the functional checks passing but returned `BLOCKED` because OCR was unavailable and no separate delivery-checklist file existed |

## Important Provider Note

The listed model `deepseek-v4-flash-0731` returned a real upstream HTTP 503 during
one run. The same Provider and API key succeeded with
`deepseek-v4-pro-0813`. Model listing alone is therefore not proof that every
advertised model is available for inference; Quest correctly surfaces the
upstream failure instead of reporting a fake completion.

## Remaining Acceptance Work

1. Add an explicit, generated delivery checklist artifact when a runnable
   delivery is produced, or update the reviewer contract to use the verified
   `DeliveryManifest` as the authoritative checklist.
2. Install/configure a real OCR capability before requiring screenshot text
   comparison. An unavailable OCR dependency must remain `BLOCKED`, never
   `PASS`.
3. Repeat the same end-to-end run after those environment/contract changes.

## Automated Verification

- `npm run typecheck`
- `npm test -- --run` (125 test files, 1250 passed, 1 skipped)
- `npm run build`
- Hermes runtime health and auth smoke
- Quest embedded Workbench desktop smoke

