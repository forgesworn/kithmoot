// Member epoch catch-up lives in @forgesworn/fold-kit (0.5.0). Re-exported
// here, unchanged: any current member can bring an admitted, non-removed
// device that missed a rekey up to date while the authority is offline, and
// the device checks the answer against the authority's signed rekey chain.
// See fold-kit's docs/member-epoch-catch-up.md, and `RoomSession`, which
// runs both sides.
export {
  MEMBER_EPOCH_KINDS,
  MEMBER_EPOCH_REQUEST_KEY_INFO,
  MAX_MEMBER_EPOCH_CHAIN,
  deriveMemberEpochRequestKey,
  readRekeyEvidence,
  encodeMemberEpochRequest,
  decodeMemberEpochRequest,
  encodeMemberEpochGrant,
  decodeMemberEpochGrant,
  hostMemberEpochDesk,
  memberEpochSource,
  requestMemberEpoch,
  MEMBER_EPOCH_LABELS,
} from '@forgesworn/fold-kit'
export type {
  RekeyEvidence,
  EncodeMemberEpochRequestOptions,
  DecodeMemberEpochRequestOptions,
  MemberEpochRequest,
  EncodeMemberEpochGrantOptions,
  DecodeMemberEpochGrantOptions,
  MemberEpochGrant,
  HostMemberEpochDeskOptions,
  MemberEpochRequestOptions,
  MemberEpochSource,
} from '@forgesworn/fold-kit'
