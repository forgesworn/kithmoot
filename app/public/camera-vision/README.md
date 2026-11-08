# Bundled foreground segmentation

Google MediaPipe Tasks Vision 0.10.35 and square Selfie Segmenter revision 1,
Copyright Google LLC / The MediaPipe Authors, Apache-2.0. The full licence is
distributed alongside this file. No endorsement is implied.

Model source:
https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/1/selfie_segmenter.tflite

Model: 249,537 bytes, SHA-256
`191ac9529ae506ee0beefa6b2c945a172dab9d07d1e802a290a4e4038226658b`.
The model matches KithMoot Android's reviewed bundled asset.

Runtime source: https://www.npmjs.com/package/@mediapipe/tasks-vision/v/0.10.35
The build verifies exact runtime hashes in scripts/camera-vision-runtime.json.
The runtime and model are served from the application's own origin, precached
for web use, and included in the desktop package. No CDN, account, Google Play
or hosted inference is required. Frames are processed locally and never uploaded
by this integration. The application still uses its configured room transports.

CPU inference runs synchronously in IMAGE mode. Each result belongs to the
current input frame; the foreground buffer is copied before closing its SDK
result. Missing or failed segmentation retains the complete blur or synthetic
backdrop. Only choosing Off permits the normal unprocessed camera picture.

Segmentation is an estimate: hair, objects and background pixels can be
misclassified. It does not guarantee concealment.
