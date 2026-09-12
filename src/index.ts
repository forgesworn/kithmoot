export { KINDS } from './kinds.js'
export { verifyEventUncached } from './verify.js'
export { generateRoomSecret, deriveRoom, encodeJoinUrl, decodeJoinUrl, parseRoomPolicy } from './room.js'
export { parseRoomLink, encodeRoomLink, safeIceUrls } from './link.js'
export type { RoomLink } from './link.js'
export { RoomAgent, AGENT_CHANNEL, TRANSCRIPT_CHANNEL, MINUTES_CHANNEL, DEFAULT_RELAYS } from './agent.js'
export { CONTROL_CHANNEL, encodeControl, decodeControl, DEFAULT_APPROVAL_OPTIONS, MAX_APPROVAL_TEXT, MAX_APPROVAL_OPTIONS } from './control.js'
export type { ControlMessage, CatalogueEntry, RunningAgent, ModelShortcut } from './control.js'
export type { JoinRoomOptions, CreateRoomOptions, KeeperState, ApprovalRequestOptions, ApprovalOutcome, IgnoredApproval } from './agent.js'
export { parseKeeperState, serialiseKeeperState, KEEPER_STATE_VERSION } from './keeper-state.js'
export type { StoredKeeperState } from './keeper-state.js'
export {
  deriveEpoch,
  generateEpochSecret,
  encodeRekeyEvent,
  decodeRekeyEvent,
  peekRekeyEvent,
  encodeEpochRequest,
  decodeEpochRequest,
  encodeEpochGrant,
  decodeEpochGrant,
  hostRoomEpoch,
  requestRoomEpoch,
  EpochRefusedError,
  signAdmins,
  verifyAdmins,
  canonicalAdmins,
  signChannels,
  verifyChannels,
  canonicalChannels,
  CHANNEL_NAME,
  RESERVED_CHANNELS,
  MAX_EPOCH,
} from './epoch.js'
export type {
  RoomEpoch,
  EpochKeys,
  RekeyNotice,
  EpochRefusal,
  EpochRequest,
  EpochGrant,
  EncodeRekeyOptions,
  DecodeRekeyOptions,
  PeekRekeyOptions,
  EncodeEpochRequestOptions,
  DecodeEpochRequestOptions,
  EncodeEpochGrantOptions,
  DecodeEpochGrantOptions,
  HostRoomEpochOptions,
  RequestRoomEpochOptions,
  SignAdminsOptions,
  VerifyAdminsOptions,
} from './epoch.js'
export {
  createRoomInvitation,
  roomInvitation,
  deriveInvitationId,
  encodeInvitationRequest,
  decodeInvitationRequest,
  encodeInvitationGrant,
  decodeInvitationGrant,
  decodeRoomAdmissionGrant,
  verifyInvitationDelegation,
  encodeInvitationRetirement,
  decodeInvitationRetirement,
  hostRoomInvitation,
  requestRoomAdmission,
  requestRoomAdmissionCapability,
  INVITATION_DELEGATION_TTL_SECONDS,
  MAX_INVITATION_DELEGATION_DEPTH,
} from './invitation.js'
export type {
  RoomInvitation,
  RoomInvitationHost,
  InvitationDelegation,
  RoomInvitationDelegate,
  RoomAdmission,
  EncodeInvitationRequestOptions,
  DecodeInvitationRequestOptions,
  EncodeInvitationGrantOptions,
  DecodeInvitationGrantOptions,
  EncodeInvitationRetirementOptions,
  HostRoomInvitationOptions,
  RequestRoomAdmissionOptions,
} from './invitation.js'
export { createDeviceCredential, verifyDeviceCredential, PERSON_CREDENTIAL_MAX_SECONDS } from './credential.js'
export { encodePersistentInvitation, decodePersistentInvitation, requestPersistentRoomAdmission } from './persistent-invitation.js'
export type { PersistentRoomAdmission } from './persistent-invitation.js'
export type { CreateCredentialOptions, VerifyResult } from './credential.js'
export { localIdentity } from './identity.js'
export { sanitiseDisplayName, MAX_DISPLAY_NAME_LENGTH } from './display-name.js'
export type { ParticipantIdentity, UnsignedEvent } from './identity.js'
export { encodeRosterEvent, decodeRosterEvent } from './roster.js'
export { resolveSingularRoles } from './roles.js'
export type { RoleAssignment } from './roles.js'
export { wrapSignal, unwrapSignal, unwrapSignalEvent, SIGNAL_EXPIRATION_SECONDS, SIGNAL_PROFILE, MAX_SIGNAL_WRAP_LENGTH } from './signal.js'
export type { AnnotationPoint, ScreenAnnotation, SignalBody } from './signal.js'
export type { RosterEntry, TrackAdvert, TrackRole, SingularRole, DeviceCredential, CallMembership } from './types.js'
export {
  RoomSession,
  PRESENCE_TTL_SECONDS,
  HEARTBEAT_INTERVAL_MS,
  CREDENTIAL_RENEWAL_FRACTION,
  DEFAULT_EPOCH_SETTLE_MS,
  DEFAULT_EPOCH_REQUEST_TIMEOUT_MS,
} from './session.js'
export type {
  ParticipantView,
  CallView,
  PublishOptions,
  RoomSessionOptions,
  RoomSessionBaseOptions,
  PrimaryRoomSessionOptions,
  SecondaryRoomSessionOptions,
} from './session.js'
export {
  createPairingCode,
  encodePairingRequest,
  decodePairingRequest,
  encodePairingGrant,
  decodePairingGrant,
  hostPairing,
  requestPairing,
} from './pairing.js'
export type {
  EncodePairingRequestOptions,
  DecodePairingRequestOptions,
  EncodePairingGrantOptions,
  DecodePairingGrantOptions,
  HostPairingOptions,
  RequestPairingOptions,
} from './pairing.js'
export { NostrRelayPool, normaliseRelayConfig } from './relay-pool.js'
export { LANES, LANE_MEANING, LANE_LABEL, LANE_GLYPH, isLane, laneOfRelayUrl, laneOfRelays, weakestLane, isDowngrade } from './lane.js'
export { QUIET_SLOT_SECONDS, QUIET_KINDS, QUIET_DEVICE_SLOTS, QUIET_HISTORY_SECONDS, QUIET_BUCKET_BYTES, QUIET_CANNOT_SEND, QUIET_TOO_LONG, isQuietPolicy, quietCounterRange, quietRoomTransport } from './quiet.js'
export type { QuietRoomOptions, QuietRoomTransport, QuietUsedState } from './quiet.js'
export {
  CADENCE_VERSION,
  CADENCE_EPOCH_SECONDS,
  CADENCE_SLOT_SECONDS,
  CADENCE_BUCKET_BYTES,
  CADENCE_DEVICE_SLOTS,
  CADENCE_COUNTERS_PER_DEVICE,
  CADENCE_MAX_LEASE_EPOCHS,
  CADENCE_MAX_FUTURE_START_EPOCHS,
  CADENCE_INNER_KINDS,
  CADENCE_CONTENT_TYPE,
  CADENCE_AUTH_KIND,
  cadenceServer,
  cadenceLeasePath,
  cadenceQueuePath,
  cadenceLeaseStatusPath,
  cadenceStopPath,
  cadenceWithdrawPath,
  deriveCadenceDropPublicKeys,
  buildCadenceLease,
  buildCadenceQueue,
  buildCadenceMutation,
  buildCadenceStatus,
  serialiseCadenceBody,
  cadencePayloadSha256,
  signCadenceRequest,
} from './box-cadence.js'
export type {
  CadenceDropPublicKey,
  CadenceLeaseRequest,
  CadenceQueueRequest,
  CadenceMutationRequest,
  CadenceStatusRequest,
  CadenceReceipt,
  CadenceSignedRequest,
  CadenceScope,
  BuildCadenceLeaseOptions,
} from './box-cadence.js'
export type { AgentQuietOptions } from './agent.js'
export type { Lane } from './lane.js'
export type { RelayTransport, RelayConfig, RelayHealth } from './relay-pool.js'
export { evaluateAccess, evaluateAgentAccess, issueKindredProof } from './access.js'
export type { IssueKindredProofOptions } from './access.js'
export type { AccessTier, AgentRule, RoomPolicy, KindredProof, AgentOwnership } from './types.js'
export { issueAgentOwnership, verifyAgentOwnership, normaliseAgentOwnership } from './ownership.js'
export type { IssueAgentOwnershipOptions, VerifyAgentOwnershipOptions, OwnershipVerdict } from './ownership.js'
export { Peer } from './peer.js'
export type { RTCPeerConnectionLike, PeerFactory, PeerOptions, PeerContext, RouteTier } from './peer.js'
export { Mesh, DEFAULT_FORWARDER_TIMEOUT_MS, DEFAULT_ROUTE_TIMEOUT_MS, DEFAULT_TURN_ROUTE_TIMEOUT_MS, EXHAUSTED_RETRY_MS, MAX_EXHAUSTED_RETRY_MS } from './mesh.js'
export type { MeshOptions, MeshSession, RemoteAnnotation, RemoteTrack, ForwardingState, RouteView } from './mesh.js'
export {
  ReachabilityProbe,
  classifyReachability,
  isGloballyRoutable,
  parseIceCandidate,
} from './reachability.js'
export type { CandidateLike, CandidateType, ParsedCandidate, Reachability, ReachabilityReport } from './reachability.js'
export {
  ASSIST_STREAMS_PER_PAIR,
  MAX_ASSISTED_PAIRS,
  assistCostBps,
  assistDecision,
  assistPairKey,
  assistSlots,
  buildAssistOffer,
  rankAssistants,
  sanitiseAssistOffer,
  selectAssistant,
  spareUplinkBps,
} from './peer-assist.js'
export type {
  AssistBlock,
  AssistCandidate,
  AssistDecision,
  AssistEnvironment,
  AssistSelectionOptions,
  AssistVolunteer,
} from './peer-assist.js'
export type { AssistOffer } from './types.js'
export { DEFAULT_RELAY_QUEUE, FrameRelay, PeerRelay, RelayPair, detectRelayCapability } from './peer-relay.js'
export type {
  DetectRelayOptions,
  EncodedStreamPair,
  PeerRelayOptions,
  RelayCapability,
  RelayMechanism,
  RelayScope,
  RelayStats,
} from './peer-relay.js'
export { UplinkProbe, summariseStats, MIN_SAMPLE_MS, STALE_AFTER_MS } from './uplink.js'
export type { StatLike } from './uplink.js'
export {
  encodeChatEvent,
  decodeChatEvent,
  deriveChannel,
  ChatLog,
  MAX_CHANNEL_NAME_LENGTH,
  MAX_CHAT_TEXT_LENGTH,
  CHAT_RETENTION_SECONDS,
  MAX_CHAT_MESSAGES,
  MAX_CHAT_MESSAGES_PER_MINUTE,
  MAX_CHAT_ATTACHMENTS,
  MAX_ATTACHMENT_URL_LENGTH,
  MAX_ATTACHMENT_NAME_LENGTH,
  normaliseAttachment,
} from './chat.js'
export type {
  ChatMessage,
  ChatMessageKind,
  ChatAttachment,
  EpochRoot,
  ChatLogOptions,
  EncodeChatOptions,
  DecodeChatOptions,
  SendOptions,
} from './chat.js'
export {
  decryptEnvelope,
  fetchAttachment,
  verifyEnvelopeHash,
  sha256Hex,
  parseRecoveryKey,
  formatRecoveryKey,
  deriveEnvelopeKey,
  canonicalEnvelopeName,
  paddedPlaintextLength,
  DEFAULT_MAX_ATTACHMENT_BYTES,
  encryptEnvelope,
  uploadEnvelope,
  buildFileEvent,
  buildUploadAuthorisation,
  encodeBlossomAuthorisation,
  normaliseBlossomServer,
  ENVELOPE_MEDIA_TYPE,
  ENVELOPE_FILE_NAME,
  ENVELOPE_SCHEME,
  MAX_UPLOAD_SOURCE_BYTES,
  BLOSSOM_AUTH_KIND,
  FILE_EVENT_KIND,
  UPLOAD_AUTHORISATION_LIFETIME_SECONDS,
} from './attachment.js'
export type {
  DecryptedEnvelope,
  FetchAttachmentOptions,
  EnvelopeSource,
  EncryptEnvelopeOptions,
  EncryptedEnvelope,
  BlossomDescriptor,
  UploadEnvelopeOptions,
} from './attachment.js'
export { mintTurnCredential } from './turn.js'
export type { TurnCredential } from './turn.js'
export { needsForwarding, selectForwarder, DEFAULT_HEADROOM } from './forwarder.js'
export type { CapacityEstimate } from './forwarder.js'
export type { ForwarderRef, IceServerRef } from './types.js'
export { encodeDescriptorEvent, decodeDescriptorEvent, parseForwarderRef } from './descriptor.js'
export type { EncodeDescriptorOptions, DecodeDescriptorOptions } from './descriptor.js'
export type { RoomDescriptor } from './types.js'
export {
  deriveMediaKey,
  encryptFrame,
  decryptFrame,
  frameIv,
  randomFrameSalt,
  resolveFrameSender,
  unencryptedPrefixLength,
  createFrameEncryptor,
  createFrameDecryptor,
  installTransforms,
  MEDIA_KEY_INFO,
  IV_LENGTH,
  SALT_LENGTH,
  TAG_LENGTH,
  TRAILER_LENGTH,
} from './media-crypto.js'
export type {
  EncodedFrameLike,
  FrameSink,
  FrameTransformer,
  FrameType,
  FrameCryptoOptions,
  FrameEndpointLike,
  TransformablePeerConnection,
  InstallTransformsOptions,
  InstalledTransforms,
} from './media-crypto.js'
export {
  VideoEffect,
  blurRadiusPx,
  clampStrength,
  coverRect,
  decideFrameAction,
  maskToAlpha,
  BLUR_ON_BY_DEFAULT,
  DEFAULT_BLUR_STRENGTH,
  MIN_BLUR_RADIUS_FRACTION,
  MAX_BLUR_RADIUS_FRACTION,
  MAX_CONSECUTIVE_SEGMENT_FAILURES,
} from './video-effects.js'
export type {
  CanvasFactory,
  CanvasLike,
  Context2DLike,
  CoverRect,
  EffectMode,
  EffectStatus,
  FrameAction,
  FrameSourceLike,
  FrameState,
  ImageDataLike,
  MaskAlphaOptions,
  SegmentationMask,
  Segmenter,
  SegmenterFactory,
  VideoEffectOptions,
  VideoEffectState,
} from './video-effects.js'
export {
  VoiceMasker,
  VOICE_PRESETS,
  DEFAULT_VOICE_PRESET,
  IDENTITY_VOICE_SETTINGS,
  FRAME_SIZE as VOICE_FRAME_SIZE,
  HOP_SIZE as VOICE_HOP_SIZE,
  OVERSAMPLING as VOICE_OVERSAMPLING,
  CEPSTRAL_LIFTER,
  MAX_SEMITONES,
  MIN_FORMANT_RATIO,
  MAX_FORMANT_RATIO,
  clampVoiceSettings,
  isIdentitySettings,
  latencySamples,
  presetLatencyMs,
  semitonesToRatio,
  spectralEnvelope,
  spectralEnvelopeInto,
  fftInPlace,
} from './voice-effects.js'
export type { VoicePreset, VoiceSettings, VoiceMaskerOptions } from './voice-effects.js'

export { SpeakingDetector, SpeakingSet, SPEAKING } from './speaking.js'
export type { SpeakingThresholds } from './speaking.js'
export { rms, rmsFromByteTimeDomain } from './audio-level.js'

export {
  DonationLedger,
  DONOR_TIERS,
  ZAP_RECEIPT_KIND,
  ZAP_REQUEST_KIND,
  bolt11Msats,
  creditFromReceipt,
  donorTier,
  fetchZapEndpoint,
  lnurlpUrl,
  ringTier,
  satsOf,
  tallyDonations,
} from './donations.js'
export type {
  CreditOptions,
  DonationLedgerOptions,
  DonorTier,
  FetchZapEndpointOptions,
  RingInput,
  TallyOptions,
  ZapCredit,
  ZapEndpoint,
} from './donations.js'

export { verificationWords, verificationStatus, VERIFY_NAMESPACE } from './verification.js'
export type { KnownParticipant, VerificationStatus, VerificationView, VerificationWords } from './verification.js'

export { REACTION_EMOJIS, normaliseReaction, reactionsFor, toggleReaction, reactionText, type ChatReaction } from './reactions.js'

export {
  normaliseMessageRef,
  refOf,
  refKey,
  sameRef,
  validMessageId,
  MAX_MESSAGE_ID_LENGTH,
  EVERYONE,
  MAX_MENTIONS,
  ROOM_MENTION_PATTERN,
  normaliseMentions,
  normaliseInvite,
  MAX_INVITE_LINK_LENGTH,
  namesInText,
  mentionsOf,
  mentionedBy,
  isConversation,
  later,
  resolveConversation,
  retractionText,
  inviteText,
} from './messages.js'
export type { MessageRef, ChatInvite, Named, ResolvedMessage, Conversation } from './messages.js'

export {
  READ_POSITION_KIND,
  READ_POSITION_LABEL,
  readPositionId,
  readPositionPlaintext,
  localSelfCrypt,
  signerSelfCrypt,
  encodeReadPositions,
  encodeReadPositionsLocal,
  decodeReadPositions,
  furtherOn,
  mergeReadPositions,
} from './read-position.js'
export type { ReadPosition, ReadPositions, ReadPositionRecord, SelfCrypt, EncodeReadPositionOptions, DecodeReadPositionOptions } from './read-position.js'

export { localPeerCrypt, dmPolicy, isDmPolicy, dmPeer, sealInvite, openInvite, preferredDm, peerCryptPubkey } from './dm.js'
export type { PeerCrypt, SealInviteOptions, OpenInviteOptions } from './dm.js'

export { ContextVault } from './context.js'
export * from './assignments.js'
export { AssignmentLog } from './assignment-log.js'
export type { AssignmentStorage, AssignmentLogOptions, AssignmentLogSnapshot } from './assignment-log.js'
export type { ContextScope, ContextRole, ContextIdentity, ContextGrant, ContextPolicy, ContextRecord, ContextPointer, ContextView, ContextVaultOptions, ContextRetrievalOptions, ContextRetrieval, ContextLink } from './context.js'

export { encodeMemberPass, decodeMemberPass, encodeServicePolicy, decodeServicePolicy, deriveServiceKey, deriveServiceRoom, normaliseServiceAudience } from './service-admission.js'
export type { MemberPass, ServicePolicy, ServiceAudience, ServicePermission, ServiceType } from './service-admission.js'

export { ProjectDirectory } from './project-directory.js'
export type { ProjectDirectoryStorage, ProjectDirectorySnapshot, SharedProject } from './project-directory.js'
export { PROJECT_APP, PROJECT_KIND, PROJECT_WRAP_KIND, projectKey, projectId, projectAuthority, projectRecord, signProject, projectForRecipient, wrapProject, unwrapProject } from './projects.js'
export type { ProjectIdentity, ProjectMember, ProjectRoom, ProjectDefinition, ProjectReference, ProjectRevision, ProjectRecord } from './projects.js'

export type { RelayAuthentication, RelayPoolOptions } from './relay-auth.js'
