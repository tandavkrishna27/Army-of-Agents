---
title: Workflow Templates
summary: Reusable task chains — create, instantiate, update, delete
---

Workflow templates are reusable ordered task chains. A template defines steps and their blocking dependencies. Instantiating a template expands it into real tasks (in the `issues` table) with `task_dependencies` wired between them.

**UI status:** The API is fully implemented. The list + step-builder UI is deferred to 1.1 (see `docs/roadmap.md`). Use the API directly in the meantime.

## List Templates

```
GET /api/companies/{companyId}/workflow-templates
```

Returns all templates for the company.

## Get Template

```
GET /api/companies/{companyId}/workflow-templates/{templateId}
```

Returns a single template with its `steps` and `dependencies`.

## Create Template

```
POST /api/companies/{companyId}/workflow-templates
```

Requires `founder` or `team_lead` role.

```json
{
  "name": "Feature Delivery",
  "description": "Standard spec-to-ship pipeline",
  "workspaceMode": "isolated",
  "agentCompletionPolicyOverride": "review_required",
  "steps": [
    {
      "order": 0,
      "title": "Write spec",
      "role": "product",
      "suggestedAssigneeType": "agent",
      "estimatedDurationHours": 4,
      "priority": "medium"
    },
    {
      "order": 1,
      "title": "Implement feature",
      "role": "engineering",
      "suggestedAssigneeType": "agent",
      "estimatedDurationHours": 16,
      "priority": "high"
    },
    {
      "order": 2,
      "title": "QA review",
      "role": "qa",
      "suggestedAssigneeType": "human",
      "estimatedDurationHours": 4,
      "priority": "medium"
    }
  ],
  "dependencies": [
    { "fromStep": 0, "toStep": 1 },
    { "fromStep": 1, "toStep": 2 }
  ]
}
```

**Step fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `order` | integer ≥ 0 | Yes | Step position (0-indexed, must be unique) |
| `title` | string | Yes | Step display name |
| `description` | string | No | Detail text |
| `role` | string | No | Role hint (e.g. `"engineering"`, `"product"`) |
| `suggestedAssigneeType` | string | No | `"agent"` or `"human"` |
| `suggestedDepartmentId` | uuid | No | Preferred department for assignment |
| `estimatedDurationHours` | number ≥ 0 | No | Estimated effort |
| `priority` | string | No | `urgent` \| `high` \| `medium` \| `low` |

**Dependency fields:**

| Field | Type | Description |
|-------|------|-------------|
| `fromStep` | integer | The step that must complete first (blocker) |
| `toStep` | integer | The step that is blocked |

`fromStep` and `toStep` must be different. Circular dependencies are not validated server-side — design your DAG carefully.

Returns `201` with the created template.

`agentCompletionPolicyOverride` is optional and accepts `review_required`, `agent_can_complete`, or `null`. Only a human operator with task-assignment authority may set or change it. It overrides company and project/department defaults for tasks instantiated from the template, unless a task-level override is supplied or the company review guardrail forces review. Each generated task stores the resolved policy and provenance snapshot.

## Update Template

```
PATCH /api/companies/{companyId}/workflow-templates/{templateId}
```

Requires `founder` or `team_lead` role. All fields optional. Replaces `steps` and `dependencies` if provided (not merged).

## Instantiate Template

```
POST /api/companies/{companyId}/workflow-templates/{templateId}/instantiate
```

Requires `founder` or `team_lead` role.

```json
{
  "goalId": "{goalId}",
  "projectId": "{projectId}"
}
```

Both fields are required. Creates one task per step in the template, all linked to the given goal and project. Creates `task_dependencies` rows for each dependency pair. Increments `instantiationCount` on the template.

Returns `201`:

```json
{
  "tasksCreated": ["{taskId1}", "{taskId2}", "{taskId3}"],
  "dependenciesCreated": 2
}
```

The returned task IDs correspond to steps in `order` order. After instantiation, task assignees can be set via `PATCH /api/issues/{taskId}`.

## Delete Template

```
DELETE /api/companies/{companyId}/workflow-templates/{templateId}
```

Requires `founder` or `team_lead` role. Deletes the template record. Does not affect tasks already created by previous instantiations.

Returns the deleted template.

## Notes

- Templates live in the `workflow_templates` table. Schema: `name`, `description`, `steps` (JSONB ordered array), `dependencies` (JSONB `fromStep`/`toStep` pairs), `instantiationCount`, `workspaceMode`, `agentCompletionPolicyOverride`.
- Tasks created by instantiation are ordinary tasks — they can be edited, reassigned, and managed via the standard task API.
- The `workspaceMode` field sets the execution workspace mode for all instantiated tasks: `department_default` \| `shared` \| `isolated`.
