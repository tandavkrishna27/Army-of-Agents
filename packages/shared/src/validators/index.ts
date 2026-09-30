export {
  createCompanySchema,
  updateCompanySchema,
  type CreateCompany,
  type UpdateCompany,
} from "./company.js";
export {
  portabilityIncludeSchema,
  portabilitySecretRequirementSchema,
  portabilityCompanyManifestEntrySchema,
  portabilityAgentManifestEntrySchema,
  portabilityProjectManifestEntrySchema,
  portabilitySkillManifestEntrySchema,
  portabilitySkillFileInventoryEntrySchema,
  portabilityRoutineManifestEntrySchema,
  portabilityRoutineTriggerManifestEntrySchema,
  portabilityRoutineVariableManifestEntrySchema,
  portabilityEnvInputManifestEntrySchema,
  portabilityInternalAgentConfigManifestSchema,
  portabilityBudgetPolicyManifestSchema,
  portabilityFinanceEventManifestSchema,
  portabilityQuotaWindowManifestSchema,
  portabilityWorkflowTemplateManifestSchema,
  portabilityManifestSchema,
  portabilitySourceSchema,
  portabilityTargetSchema,
  portabilityAgentSelectionSchema,
  portabilityCollisionStrategySchema,
  companyPortabilityExportSchema,
  companyPortabilityPreviewSchema,
  companyPortabilityImportSchema,
  type CompanyPortabilityExport,
  type CompanyPortabilityPreview,
  type CompanyPortabilityImport,
} from "./company-portability.js";

export {
  createAgentSchema,
  createAgentHireSchema,
  updateAgentSchema,
  adapterModelFamilyMismatch,
  isShellSafeModelId,
  updateAgentInstructionsPathSchema,
  updateAgentInstructionsBundleSchema,
  upsertAgentInstructionsFileSchema,
  createAgentKeySchema,
  wakeAgentSchema,
  resetAgentSessionSchema,
  testAdapterEnvironmentSchema,
  agentPermissionsSchema,
  updateAgentPermissionsSchema,
  type CreateAgent,
  type CreateAgentHire,
  type UpdateAgent,
  type UpdateAgentInstructionsPath,
  type UpdateAgentInstructionsBundle,
  type UpsertAgentInstructionsFile,
  type CreateAgentKey,
  type WakeAgent,
  type ResetAgentSession,
  type TestAdapterEnvironment,
  type UpdateAgentPermissions,
} from "./agent.js";

export {
  createProjectSchema,
  updateProjectSchema,
  createProjectWorkspaceSchema,
  updateProjectWorkspaceSchema,
  type CreateProject,
  type UpdateProject,
  type CreateProjectWorkspace,
  type UpdateProjectWorkspace,
} from "./project.js";

export {
  createIssueSchema,
  createIssueLabelSchema,
  updateIssueSchema,
  checkoutIssueSchema,
  addIssueCommentSchema,
  linkIssueApprovalSchema,
  createIssueAttachmentMetadataSchema,
  type CreateIssue,
  type CreateIssueLabel,
  type UpdateIssue,
  type CheckoutIssue,
  type AddIssueComment,
  type LinkIssueApproval,
  type CreateIssueAttachmentMetadata,
  issueDocumentKeySchema,
  issueDocumentFormatSchema,
  upsertIssueDocumentSchema,
  ISSUE_DOCUMENT_FORMATS,
  type UpsertIssueDocument,
} from "./issue.js";

export {
  createGoalSchema,
  updateGoalSchema,
  type CreateGoal,
  type UpdateGoal,
} from "./goal.js";

export {
  submitBraindumpSchema,
  BRAINDUMP_CONTENT_MAX_LENGTH,
  type SubmitBraindump,
} from "./braindump.js";

export {
  createMemoryItemSchema,
  updateMemoryItemSchema,
  suggestMemoryUpdateSchema,
  suggestMemoryArchiveSchema,
  type CreateMemoryItem,
  type UpdateMemoryItem,
  type SuggestMemoryUpdate,
  type SuggestMemoryArchive,
  // Memory infrastructure
  memoryProfileSchema,
  memoryWriteCapabilitiesSchema,
  createMemoryRelationSchema,
  memoryRetrievalRowSchema,
  memoryExtractionProgressSchema,
  createMemoryExtractionSchema,
  createMemoryExtractionBatchSchema,
  type MemoryProfile,
  type MemoryWriteCapabilities,
  type CreateMemoryRelation,
  type MemoryRetrievalRow,
  type MemoryExtractionProgress,
  type CreateMemoryExtraction,
  type CreateMemoryExtractionBatch,
} from "./memory.js";

export {
  companyBrainNodeRefSchema,
  companyBrainNodeSchema,
  companyBrainEdgeSchema,
  companyBrainNeighborQuerySchema,
  companyBrainNeighborsResponseSchema,
  companyBrainOverviewQuerySchema,
  companyBrainOverviewResponseSchema,
  createCompanyBrainSemanticEdgeSchema,
  updateCompanyBrainSemanticEdgeSchema,
  type CompanyBrainNodeRefInput,
  type CompanyBrainNodeInput,
  type CompanyBrainEdgeInput,
  type CompanyBrainNeighborQuery,
  type CompanyBrainNeighborsResponseInput,
  type CompanyBrainOverviewQuery,
  type CompanyBrainOverviewResponseInput,
  type CreateCompanyBrainSemanticEdge,
  type UpdateCompanyBrainSemanticEdge,
} from "./company-brain-graph.js";

export {
  memoryFolderCreateSchema,
  memoryFolderUpdateSchema,
  normalizeMemoryFolderPath,
} from "./memory-folder.js";

export {
  memoryAssetUpdateSchema,
  memoryAssetMoveSchema,
} from "./memory-asset.js";

export {
  createDebriefSchema,
  mcpDebriefSchema,
  updateDebriefSchema,
  type CreateDebrief,
  type McpDebrief,
  type UpdateDebrief,
} from "./debrief.js";

export {
  updateBriefSchema,
  createBriefItemSchema,
  updateBriefItemSchema,
  approveBriefSchema,
  type UpdateBrief,
  type CreateBriefItem,
  type UpdateBriefItem,
  type ApproveBrief,
} from "./brief.js";

export {
  createApprovalSchema,
  resolveApprovalSchema,
  requestApprovalRevisionSchema,
  resubmitApprovalSchema,
  addApprovalCommentSchema,
  type CreateApproval,
  type ResolveApproval,
  type RequestApprovalRevision,
  type ResubmitApproval,
  type AddApprovalComment,
} from "./approval.js";

export {
  envBindingPlainSchema,
  envBindingSecretRefSchema,
  envBindingSchema,
  envConfigSchema,
  readEnvBindingValue,
  createSecretSchema,
  rotateSecretSchema,
  updateSecretSchema,
  secretProviderConfigPayloadSchema,
  createSecretProviderConfigSchema,
  updateSecretProviderConfigSchema,
  createSecretBindingSchema,
  createRuntimeProviderKeySchema,
  remoteSecretImportPreviewSchema,
  remoteSecretImportCommitSchema,
  updateRuntimeProviderKeySchema,
  createRuntimeProviderKeyWithSecretSchema,
  type CreateSecret,
  type RotateSecret,
  type UpdateSecret,
  type CreateSecretProviderConfig,
  type UpdateSecretProviderConfig,
  type CreateSecretBinding,
  type RemoteSecretImportPreview,
  type RemoteSecretImportCommit,
  type CreateRuntimeProviderKey,
  type UpdateRuntimeProviderKey,
  type CreateRuntimeProviderKeyWithSecret,
} from "./secret.js";

export {
  createCostEventSchema,
  updateBudgetSchema,
  type CreateCostEvent,
  type UpdateBudget,
} from "./cost.js";

export {
  financeDirectionSchema,
  createFinanceEventSchema,
  financeDateRangeQuerySchema,
  financeListQuerySchema,
  type CreateFinanceEvent,
  type FinanceListQuery,
} from "./finance.js";

export {
  createAssetImageMetadataSchema,
  createAssetFileMetadataSchema,
  type CreateAssetImageMetadata,
  type CreateAssetFileMetadata,
} from "./asset.js";

export {
  createArtifactSchema,
  updateArtifactSchema,
  createArtifactVersionSchema,
  mcpArtifactVersionSchema,
  mcpArtifactVersionShape,
  type CreateArtifact,
  type UpdateArtifact,
  type CreateArtifactVersion,
  type McpArtifactVersion,
} from "./artifact.js";

export {
  taskOutputTypeSchema,
  taskOutputStatusSchema,
  taskOutputReviewStateSchema,
  upsertTaskOutputSchema,
  mutableTaskOutputSchema,
  type UpsertTaskOutput,
  type MutableTaskOutput,
} from "./task-output.js";

export {
  createMcpApiKeySchema,
  updateMcpSettingsSchema,
  type CreateMcpApiKey,
  type UpdateMcpSettings,
} from "./mcp.js";

export {
  confirmDetectedOutputSchema,
  type ConfirmDetectedOutput,
} from "./output-detection.js";

export {
  createCompanyInviteSchema,
  acceptInviteSchema,
  listJoinRequestsQuerySchema,
  claimJoinRequestApiKeySchema,
  updateMemberPermissionsSchema,
  updateUserCompanyAccessSchema,
  searchAdminUsersQuerySchema,
  boardCliAuthAccessLevelSchema,
  createCliAuthChallengeSchema,
  resolveCliAuthChallengeSchema,
  type CreateCompanyInvite,
  type AcceptInvite,
  type ListJoinRequestsQuery,
  type ClaimJoinRequestApiKey,
  type UpdateMemberPermissions,
  type UpdateUserCompanyAccess,
  type SearchAdminUsersQuery,
} from "./access.js";

export {
  updateTeamMemberRoleSchema,
  addMemberSchema,
  transferAdminSchema,
  reassignAndRemoveSchema,
  HUMAN_SOCIAL_LINK_TYPES,
  STANDARD_HUMAN_CAPABILITY_DOCUMENTS,
  humanSocialLinkSchema,
  createHumanCapabilityDocumentSchema,
  updateHumanCapabilityDocumentSchema,
  updateCompanyUserProfileSchema,
  searchHumansSchema,
  type UpdateTeamMemberRole,
  type AddMember,
  type TransferAdmin,
  type ReassignAndRemove,
  type UpdateCompanyUserProfile,
  type CreateHumanCapabilityDocument,
  type UpdateHumanCapabilityDocument,
  type SearchHumans,
} from "./team.js";

export {
  currentUserProfileSchema,
  updateCurrentUserProfileSchema,
  type CurrentUserProfile,
  type UpdateCurrentUserProfile,
} from "./auth-profile.js";

export {
  workflowStepSchema,
  workflowDependencySchema,
  createWorkflowTemplateSchema,
  updateWorkflowTemplateSchema,
  type CreateWorkflowTemplate,
  type UpdateWorkflowTemplate,
} from "./workflow-template.js";

export {
  createDiscussionSchema,
  createDiscussionEntrySchema,
  updateDiscussionSchema,
  approveItemsSchema,
  createAnnotationSchema,
  type CreateDiscussion,
  type CreateDiscussionEntry,
  type UpdateDiscussion,
  type ApproveItems,
  type CreateAnnotation,
} from "./discussion.js";

export {
  updateInternalAgentConfigSchema,
  commanderContextScopeSchema,
  commanderContextSurfaceSchema,
  chatMessageSchema,
  type UpdateInternalAgentConfig,
  type CommanderContextScope,
  type ChatMessage,
} from "./internal-agent.js";

export {
  upsertBudgetPolicySchema,
  resolveBudgetIncidentSchema,
  type UpsertBudgetPolicy,
  type ResolveBudgetIncident,
} from "./budget.js";

export {
  companySkillSourceTypeSchema,
  companySkillTrustLevelSchema,
  companySkillCompatibilitySchema,
  companySkillSourceBadgeSchema,
  companySkillFileInventoryEntrySchema,
  companySkillSchema,
  companySkillListItemSchema,
  companySkillUsageAgentSchema,
  companySkillDetailSchema,
  companySkillUpdateStatusSchema,
  companySkillImportSchema,
  companySkillProjectScanRequestSchema,
  companySkillProjectScanSkippedSchema,
  companySkillProjectScanConflictSchema,
  companySkillProjectScanResultSchema,
  companySkillCreateSchema,
  companySkillFileDetailSchema,
  companySkillFileUpdateSchema,
  companySkillImportPackageSchema,
  type CompanySkillImport,
  type CompanySkillProjectScan,
  type CompanySkillCreate,
  type CompanySkillFileUpdate,
} from "./company-skill.js";

export {
  routineVariableSchema,
  createRoutineSchema,
  updateRoutineSchema,
  createRoutineTriggerSchema,
  updateRoutineTriggerSchema,
  runRoutineSchema,
  rotateRoutineTriggerSecretSchema,
  restoreRoutineRevisionSchema,
  type CreateRoutine,
  type UpdateRoutine,
  type CreateRoutineTrigger,
  type UpdateRoutineTrigger,
  type RunRoutine,
  type RestoreRoutineRevision,
} from "./routine.js";

export {
  instanceGeneralSettingsSchema,
  patchInstanceGeneralSettingsSchema,
  instanceExperimentalSettingsSchema,
  patchInstanceExperimentalSettingsSchema,
  backupRetentionPolicySchema,
  feedbackDataSharingPreferenceSchema,
  type PatchInstanceGeneralSettings,
  type PatchInstanceExperimentalSettings,
} from "./instance.js";

export {
  executionWorkspaceStatusSchema,
  executionWorkspaceConfigSchema,
  workspaceRuntimeControlTargetSchema,
  executionWorkspaceCloseReadinessStateSchema,
  executionWorkspaceCloseActionKindSchema,
  executionWorkspaceCloseActionSchema,
  executionWorkspaceCloseLinkedIssueSchema,
  executionWorkspaceCloseGitReadinessSchema,
  workspaceRuntimeServiceSchema,
  executionWorkspaceCloseReadinessSchema,
  updateExecutionWorkspaceSchema,
  type UpdateExecutionWorkspace,
} from "./execution-workspace.js";

export {
  feedbackTargetTypeSchema,
  feedbackVoteValueSchema,
  upsertIssueFeedbackVoteSchema,
  type UpsertIssueFeedbackVote,
} from "./feedback.js";

export {
  pluginManifestV1Schema,
  type PluginManifestV1Input,
} from "./plugin.js";

export {
  sidebarPreferencesSchema,
  updateSidebarPreferencesSchema,
  type SidebarPreferences,
  type UpdateSidebarPreferences,
} from "./sidebar-preferences.js";

export {
  DEFAULT_UNIVERSE_PREFERENCES,
  UNIVERSE_PREFERENCE_SECTIONS,
  resolveUniversePreferences,
  universePreferencesSchema,
  universePreferencePatchSchema,
  universePreferenceResetSchema,
  type UniversePreferences,
  type UniversePreferenceOverrides,
  type PreferenceSection,
  type UniversePreferencesSnapshot,
  type UniversePreferencePatchInput,
  type UniversePreferenceResetInput,
} from "./universe-preferences.js";

export {
  homeBoardLayoutItemSchema,
  homeBoardLayoutArraySchema,
  updateHomeBoardLayoutSchema,
  validateHomeBoardLayout,
  type HomeBoardLayoutItemInput,
  type HomeBoardLayoutItemLike,
  type HomeBoardLayoutValidationResult,
  type UpdateHomeBoardLayout,
} from "./home-board-layout.js";

export {
  UNIVERSE_REF_KINDS,
  UNIVERSE_LAYOUT_SCHEMA_VERSION,
  UNIVERSE_LAYOUT_MAX_PANELS,
  UNIVERSE_LAYOUT_MAX_OPERATIONS,
  UNIVERSE_LAYOUT_COORD_LIMIT,
  UNIVERSE_LAYOUT_MIN_DIMENSION,
  UNIVERSE_LAYOUT_MAX_DIMENSION,
  UNIVERSE_LAYOUT_MIN_ZOOM,
  UNIVERSE_LAYOUT_MAX_ZOOM,
  rectSchema,
  layoutOpSchema,
  layoutPatchSchema,
  universeLayoutDocumentSchema,
  emptyUniverseLayoutDocument,
  type UniverseRefKind,
  type Rect,
  type LayoutOp,
  type LayoutPatch,
  type LayoutAck,
  type UniverseLayoutDocument,
} from "./universe-layout.js";

export {
  UNIVERSE_DRAFT_DESTINATION_KINDS,
  UNIVERSE_DRAFT_SCHEMA_VERSION,
  UNIVERSE_DRAFT_MAX_TEXT,
  UNIVERSE_DRAFT_MAX_ATTACHMENTS,
  draftDestinationSchema,
  draftPatchSchema,
  universeDraftPayloadSchema,
  pendingDraftAttemptSchema,
  structuredDraftPatchSchema,
  universeDraftPatchSchema,
  type UniverseDraftDestinationKind,
  type UniverseDraftDestination,
  type UniverseDraftPatch,
  type UniverseDraft,
  type UniverseDraftPayload,
  type PendingDraftAttempt,
  type UniverseDraftPatchInput,
} from "./universe-draft.js";

export {
  INBOX_DISMISSAL_ITEM_KEY_REGEX,
  inboxDismissalSchema,
  createInboxDismissalSchema,
  type InboxDismissal,
  type CreateInboxDismissal,
} from "./inbox-dismissals.js";

export {
  createEnvironmentSchema,
  e2bEnvironmentConfigSchema,
  environmentDriverSchema,
  environmentLeaseCleanupStatusSchema,
  environmentLeasePolicySchema,
  environmentLeaseStatusSchema,
  environmentStatusSchema,
  probeEnvironmentSchema,
  updateEnvironmentSchema,
  type CreateEnvironmentInput,
  type E2bEnvironmentConfig,
  type ProbeEnvironmentInput,
  type UpdateEnvironmentInput,
} from "./environment.js";

// Phase 5 execution-target registry (Task 5) — this validators file existed
// but was never re-exported through the barrel; fixed here because Task 13's
// registry route needs createExecutionTargetSchema via "@armyofagents/shared".
export {
  dockerIsolationSchema,
  gvisorEnvironmentConfigSchema,
  createExecutionTargetSchema,
  workerExecutionTargetHeartbeatSchema,
  issueWorkerEnrollmentCodeSchema,
  type CreateExecutionTargetInput,
  type WorkerExecutionTargetHeartbeatInput,
  type IssueWorkerEnrollmentCodeInput,
} from "./execution-target.js";

export { isGitHubRepoUrl } from "./github.js";

export {
  submitJobCommandSchema,
  submitJobSourceSchema,
  type SubmitJobCommandInput,
} from "./job-control.js";

export {
  createUserEntityPinSchema,
  type CreateUserEntityPin,
} from "./user-entity-pins.js";

export {
  createUserNoteSchema,
  updateUserNoteSchema,
  userNoteColorSchema,
  type CreateUserNote,
  type UpdateUserNote,
} from "./user-notes.js";

export {
  listHubItemsQuery,
  hubActionSchema,
  hubUserStateSchema,
  hubBulkActionSchema,
  hubUndoSchema,
  hubPreferencesSchema,
  updateHubPreferencesSchema,
  hubAutopilotPolicySchema,
  updateHubAutopilotPolicySchema,
  hubAutopilotEvaluationResultSchema,
  hubAutopilotActionsResponseSchema,
  hubListRowSchema,
  hubListResponseSchema,
  hubCurationMetadataSchema,
  runtimeDecisionAnswerSchema,
  runtimeDecisionDetailSchema,
  type ListHubItemsQuery,
  type HubActionInput,
  type HubUserStateInput,
  type HubBulkActionInput,
  type HubUndoInput,
  type HubPreferences,
  type UpdateHubPreferencesInput,
  type HubAutopilotRule,
  type HubAutopilotPolicy,
  type UpdateHubAutopilotPolicyInput,
  type HubAutopilotEvaluationResult,
  type HubAutopilotActionRow,
  type HubAutopilotActionsResponse,
  type HubListRow,
  type HubListResponse,
  type HubCurationMetadata,
  type RuntimeDecisionAnswerInput,
  type RuntimeDecisionDetail,
} from "./hub.js";

export { checkpointDataSchema, checkpointPatchSchema, type CheckpointData, type CheckpointPatch, type CheckpointSnapshot } from "./universe-layout.js";
export {
  universeAttentionSourceRefSchema,
  universeAttentionEntrySchema,
  universeAttentionResponseSchema,
  universeAttentionCheckpointInputSchema,
  universeAttentionCheckpointSchema,
  type UniverseAttentionSourceRef,
  type UniverseAttentionEntry,
  type UniverseAttentionResponse,
  type UniverseAttentionCheckpointInput,
  type UniverseAttentionCheckpoint,
} from "./universe-attention.js";
export {
  universeSnapshotReferenceSchema,
  universeSnapshotTaskSchema,
  universeSnapshotOutputSchema,
  universeReconciliationSnapshotSchema,
  type UniverseReconciliationSnapshot,
} from "./universe-reconciliation.js";
export {
  universeIntakeDestinationSchema,
  beginUniverseIntakeSchema,
  universeIntakeSnapshotSchema,
  type UniverseIntakeDestination,
  type BeginUniverseIntake,
  type UniverseIntakeSnapshot,
} from "./universe-intake.js";
export {
  FORMAT_DISPOSITIONS,
  FORMAT_FAILURES,
  formatCapabilitySchema,
  type FormatDisposition,
  type FormatCapability,
  type FormatFailure,
} from "./universe-formats.js";
