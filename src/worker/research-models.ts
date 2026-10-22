// These weights are for local evaluation; InsightFace restricts them to non-commercial research.
export const researchAssets = {
  archive: {
    name: 'buffalo_sc.zip',
    url: 'https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_sc.zip',
    sha256: '57d31b56b6ffa911c8a73cfc1707c73cab76efe7f13b675a05223bf42de47c72',
  },
  pad: {
    name: 'pad.onnx',
    url: 'https://github.com/yakhyo/face-anti-spoofing/releases/download/weights/MiniFASNetV2.onnx',
    sha256: 'b32929adc2d9c34b9486f8c4c7bc97c1b69bc0ea9befefc380e4faae4e463907',
  },
} as const;

export const researchManifest = {
  model_version: 'research-buffalo-sc-minifasnet-v2-v1',
  usage: 'RESEARCH_ONLY',
  detector: {
    path: 'detector.onnx',
    sha256: '5e4447f50245bbd7966bd6c0fa52938c61474a04ec7def48753668a9d8b4ea3a',
    license_reference:
      'https://github.com/deepinsight/insightface/blob/master/python-package/docs/model_zoo.md#model-licenses (non-commercial research only)',
    size: 640,
    score_threshold: 0.5,
    nms_threshold: 0.4,
    score_outputs: ['443', '468', '493'],
    box_outputs: ['446', '471', '496'],
    landmark_outputs: ['449', '474', '499'],
  },
  recognizer: {
    path: 'recognizer.onnx',
    sha256: '9cc6e4a75f0e2bf0b1aed94578f144d15175f357bdc05e815e5c4a02b319eb4f',
    license_reference:
      'https://github.com/deepinsight/insightface/blob/master/python-package/docs/model_zoo.md#model-licenses (non-commercial research only)',
    output: '516',
    mean: [127.5, 127.5, 127.5],
    divisor: [127.5, 127.5, 127.5],
    color: 'RGB',
  },
  pad: {
    path: 'pad.onnx',
    sha256: researchAssets.pad.sha256,
    license_reference:
      'https://github.com/yakhyo/face-anti-spoofing/blob/main/LICENSE; upstream https://github.com/minivision-ai/Silent-Face-Anti-Spoofing/blob/master/LICENSE',
    output: 'output',
    width: 80,
    height: 80,
    mean: [0, 0, 0],
    divisor: [1, 1, 1],
    color: 'BGR',
    crop_scale: 2.7,
    crop_mode: 'MINIFASNET',
    live_class: 1,
    output_mode: 'LOGITS',
  },
  quality: { min_face_pixels: 100, sharpness_reference: 100 },
};
