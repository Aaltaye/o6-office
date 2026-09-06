# O6 Office — task index

Master index. Plan: [PLAN.md](../PLAN.md). Running log: [claudecode.md](../claudecode.md).

Verification gate before any merge: `npm run build`, `npx tsc --noEmit`, `npm run lint`,
tests green, new behaviour ships with a test, smoke clean.

| ID | Title | Status | Branch | Depends on | Parallel-with | Drift |
|----|-------|--------|--------|------------|---------------|-------|
| [T001](001-event-contract.md) | Event contract & floor-plan schema | done | `task/001-event-contract` | none | T008 | |
| [T002](002-isometric-renderer.md) | Isometric office renderer | done | `task/002-isometric-renderer` | T001 | T008 | |
| [T003](003-port-workflow-to-contract.md) | Port the lead workflow to emit OfficeEvent | done | `task/003-port-workflow-to-contract` | T002 | T008 | page.tsx touched early to keep the build green |
| [T004](004-wire-office-and-palette.md) | Mount the office, adopt O6 tokens, record the demo | not_started | `task/004-wire-office-and-palette` | T003 | T008 | |
| [T005](005-local-bridge.md) | Local bridge: hook receiver, SSE, transcript usage | not_started | `task/005-local-bridge` | T001 | T006, T008 | |
| [T006](006-claude-code-mapping.md) | Claude Code hook mapping & coding floor plan | not_started | `task/006-claude-code-mapping` | T001 | T005, T008 | |
| [T007](007-bridge-dx.md) | Bridge DX: npx entry, README, coding fixture | not_started | `task/007-bridge-dx` | T005, T006 | T008 | |
| [T008](008-anthropic-provider.md) | Add Anthropic as a selectable provider | not_started | `task/008-anthropic-provider` | none | T001-T007 (disjoint files) | |

## Phases

**Phase 1 — the live office (sequential):** T001 → T002 → T003 → T004.
*Checkpoint with Abel after T004 before starting Phase 2.*

**Phase 2 — connect your work:** T005 and T006 in parallel once T001 lands, then T007.

**T008** shares no files with any other task and can run at any time.
