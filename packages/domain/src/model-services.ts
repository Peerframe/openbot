export type ModelApiProtocol = import("@openbot/protocol").ModelConnection["protocol"];

export type ModelConnectionPreset = import("@openbot/protocol").ModelConnectionPreset;

export type ModelSelection = import("@openbot/protocol").ModelSelection;

/** Public projection only. Credentials never belong in workspace or Employee DTOs. */
export type ModelConnection = import("@openbot/protocol").ModelConnection;

export type ModelServicesSnapshot = import("@openbot/protocol").ModelServicesSnapshot;

export type CreateModelConnectionInput = import("@openbot/protocol").CreateModelConnectionInput;

export type UpdateModelConnectionInput = import("@openbot/protocol").UpdateModelConnectionInput;

export type VerifyModelConnectionInput = import("@openbot/protocol").VerifyModelConnectionInput;

export type DeleteModelConnectionInput = import("@openbot/protocol").DeleteModelConnectionInput;

// Preserve the additive consumer projection for older conflict responses.
export type ModelConnectionDependencies = Omit<
  import("@openbot/protocol").ModelConnectionDependencies,
  "transcription"
> & {
  transcription?: boolean;
};

export interface ModelConnectionDeletionConflict extends ModelConnectionDependencies {
  error: "model_connection_in_use";
}

export type UpdateEmployeeModelInput = import("@openbot/protocol").UpdateEmployeeModelInput;
