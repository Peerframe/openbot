-- TS responses use an explicit codec; Python histories retain their original message format.
ALTER TABLE work_model_receipts DROP CONSTRAINT work_model_receipts_codec_check;
--> statement-breakpoint
ALTER TABLE work_model_receipts ADD CONSTRAINT work_model_receipts_codec_check
  CHECK (codec IN ('pydantic-ai2-model-response-v1','openbot-ts-model-response-v1'));
