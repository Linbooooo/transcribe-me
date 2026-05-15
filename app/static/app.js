const recordButton = document.querySelector("#recordButton");
const discardButton = document.querySelector("#discardButton");
const cleanButton = document.querySelector("#cleanButton");
const copyCleanedButton = document.querySelector("#copyCleanedButton");
const settingsButton = document.querySelector("#settingsButton");
const refreshModelsButton = document.querySelector("#refreshModelsButton");
const settingsPanel = document.querySelector("#settingsPanel");
const transcript = document.querySelector("#transcript");
const cleanedTranscript = document.querySelector("#cleanedTranscript");
const micSelect = document.querySelector("#micSelect");
const connectionStatus = document.querySelector("#connectionStatus");
const recordingState = document.querySelector("#recordingState");
const timer = document.querySelector("#timer");
const chunkStatus = document.querySelector("#chunkStatus");
const micStatus = document.querySelector("#micStatus");
const wordCount = document.querySelector("#wordCount");
const cleanStatus = document.querySelector("#cleanStatus");
const levelBar = document.querySelector("#levelBar");
const recordingPreview = document.querySelector("#recordingPreview");
const modelInput = document.querySelector("#modelInput");
const modelOptions = document.querySelector("#modelOptions");
const modelStatus = document.querySelector("#modelStatus");
const baseUrlInput = document.querySelector("#baseUrlInput");
const apiKeyInput = document.querySelector("#apiKeyInput");
const systemPrompt = document.querySelector("#systemPrompt");

let mediaRecorder;
let mediaStream;
let recordedChunks = [];
let audioContext;
let analyser;
let meterFrame;
let startedAt = 0;
let timerId;
let isRecording = false;
let lastPreviewUrl;

function setConnection(text, live = false) {
  connectionStatus.textContent = text;
  connectionStatus.classList.toggle("live", live);
}

function setRecording(active) {
  isRecording = active;
  recordButton.textContent = active ? "Stop recording" : "Start recording";
  recordButton.classList.toggle("recording", active);
  recordingState.textContent = active ? "Recording" : "Idle";
}

function updateWordCount() {
  const words = transcript.value.trim().split(/\s+/).filter(Boolean);
  wordCount.textContent = `${words.length} ${words.length === 1 ? "word" : "words"}`;
}

function normalizeInsert(text) {
  const trimmed = text.trim();
  if (!trimmed) {
    return "";
  }

  const start = transcript.selectionStart ?? transcript.value.length;
  const before = transcript.value.slice(0, start);
  const needsLeadingSpace = before.length > 0 && !/[\s\n]$/.test(before);
  return `${needsLeadingSpace ? " " : ""}${trimmed} `;
}

function insertAtCursor(text) {
  const insert = normalizeInsert(text);
  if (!insert) {
    return;
  }

  const start = transcript.selectionStart ?? transcript.value.length;
  const end = transcript.selectionEnd ?? start;
  const before = transcript.value.slice(0, start);
  const after = transcript.value.slice(end);
  transcript.value = `${before}${insert}${after}`;
  const cursor = start + insert.length;
  transcript.selectionStart = cursor;
  transcript.selectionEnd = cursor;
  transcript.focus();
  updateWordCount();
}

function pickMimeType() {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/mp4",
  ];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

function extensionForMimeType(mimeType) {
  if (mimeType.includes("ogg")) {
    return "ogg";
  }
  if (mimeType.includes("mp4") || mimeType.includes("mpeg")) {
    return "mp4";
  }
  if (mimeType.includes("wav")) {
    return "wav";
  }
  return "webm";
}

function selectedMicConstraints() {
  const deviceId = micSelect.value;
  const audio = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  };

  if (deviceId) {
    audio.deviceId = { exact: deviceId };
  }

  return { audio };
}

async function loadMicrophones() {
  if (!navigator.mediaDevices?.enumerateDevices) {
    micSelect.innerHTML = '<option value="">Default microphone</option>';
    return;
  }

  const previous = micSelect.value;
  const devices = await navigator.mediaDevices.enumerateDevices();
  const microphones = devices.filter((device) => device.kind === "audioinput");

  micSelect.innerHTML = "";
  const defaultOption = new Option("Default microphone", "");
  micSelect.append(defaultOption);

  for (const [index, device] of microphones.entries()) {
    const label = device.label || `Microphone ${index + 1}`;
    micSelect.append(new Option(label, device.deviceId));
  }

  if ([...micSelect.options].some((option) => option.value === previous)) {
    micSelect.value = previous;
  }
}

function selectedMicLabel() {
  return micSelect.selectedOptions[0]?.textContent || "Default microphone";
}

function startTimer() {
  startedAt = Date.now();
  timer.textContent = "00:00";
  timerId = window.setInterval(() => {
    const elapsed = Math.floor((Date.now() - startedAt) / 1000);
    const minutes = String(Math.floor(elapsed / 60)).padStart(2, "0");
    const seconds = String(elapsed % 60).padStart(2, "0");
    timer.textContent = `${minutes}:${seconds}`;
  }, 250);
}

function stopTimer() {
  window.clearInterval(timerId);
}

function startMeter(stream) {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) {
    return;
  }

  audioContext = new AudioContextClass();
  const source = audioContext.createMediaStreamSource(stream);
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 256;
  source.connect(analyser);

  const data = new Uint8Array(analyser.frequencyBinCount);
  const draw = () => {
    analyser.getByteFrequencyData(data);
    const average = data.reduce((sum, value) => sum + value, 0) / data.length;
    levelBar.style.transform = `scaleX(${Math.min(1, average / 90)})`;
    meterFrame = window.requestAnimationFrame(draw);
  };
  draw();
}

function stopMeter() {
  window.cancelAnimationFrame(meterFrame);
  levelBar.style.transform = "scaleX(0)";
  audioContext?.close().catch(() => {});
  audioContext = undefined;
}

async function startRecording() {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    throw new Error("Recording is not supported in this browser.");
  }

  mediaStream = await navigator.mediaDevices.getUserMedia(selectedMicConstraints());
  await loadMicrophones();
  micStatus.textContent = selectedMicLabel();

  const mimeType = pickMimeType();
  mediaRecorder = new MediaRecorder(mediaStream, mimeType ? { mimeType } : undefined);
  recordedChunks = [];

  mediaRecorder.addEventListener("dataavailable", (event) => {
    if (event.data.size > 0) {
      recordedChunks.push(event.data);
    }
  });

  mediaRecorder.start();
  startMeter(mediaStream);
  startTimer();
  setRecording(true);
  setConnection("Recording", true);
  chunkStatus.textContent = "Recording audio";
  recordingPreview.hidden = true;
}

function collectRecording() {
  return new Promise((resolve, reject) => {
    if (!mediaRecorder || mediaRecorder.state !== "recording") {
      reject(new Error("No active recording."));
      return;
    }

    mediaRecorder.addEventListener(
      "stop",
      () => {
        const mimeType = mediaRecorder.mimeType || recordedChunks[0]?.type || "audio/webm";
        const blob = new Blob(recordedChunks, { type: mimeType });
        resolve(blob);
      },
      { once: true },
    );

    mediaRecorder.requestData();
    mediaRecorder.stop();
  });
}

async function uploadRecording(blob) {
  if (!blob.size) {
    throw new Error("No audio was recorded.");
  }

  const formData = new FormData();
  const extension = extensionForMimeType(blob.type || "audio/webm");
  formData.append("file", blob, `recording.${extension}`);

  const response = await fetch("/api/transcribe", {
    method: "POST",
    body: formData,
  });
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload.detail || "Transcription failed");
  }

  return payload.text || "";
}

function showRecordingPreview(blob) {
  if (lastPreviewUrl) {
    URL.revokeObjectURL(lastPreviewUrl);
  }

  lastPreviewUrl = URL.createObjectURL(blob);
  recordingPreview.src = lastPreviewUrl;
  recordingPreview.hidden = false;
}

async function stopRecording() {
  setRecording(false);
  recordButton.disabled = true;
  chunkStatus.textContent = "Preparing audio";

  try {
    const blob = await collectRecording();
    showRecordingPreview(blob);
    stopMeter();
    stopTimer();
    mediaStream?.getTracks().forEach((track) => track.stop());
    mediaStream = undefined;

    chunkStatus.textContent = `Transcribing ${Math.round(blob.size / 1024)} KB audio`;
    const text = await uploadRecording(blob);

    if (text.trim()) {
      insertAtCursor(text);
      chunkStatus.textContent = "Transcript updated";
    } else {
      chunkStatus.textContent = "No speech found";
    }
  } catch (error) {
    recordingState.textContent = "Error";
    chunkStatus.textContent = error.message;
  } finally {
    recordButton.disabled = false;
    setConnection("Ready", true);
  }
}

async function toggleRecording() {
  recordButton.disabled = true;
  try {
    if (isRecording) {
      await stopRecording();
    } else {
      await startRecording();
    }
  } catch (error) {
    recordingState.textContent = "Error";
    chunkStatus.textContent = error.message;
    setRecording(false);
    setConnection("Ready", true);
  } finally {
    recordButton.disabled = false;
  }
}

async function loadSettings() {
  const response = await fetch("/api/settings");
  const settings = await response.json();
  modelInput.value = settings.llm_model;
  baseUrlInput.value = settings.llm_base_url;
  systemPrompt.value = settings.system_prompt;
  await loadModels();
}

function describeModels(models) {
  if (!models.length) {
    return "No models detected";
  }

  const currentModel = modelInput.value.trim();
  const preview = models.slice(0, 4).join(", ");
  const suffix = models.length > 4 ? `, +${models.length - 4} more` : "";

  if (currentModel && !models.includes(currentModel)) {
    modelInput.value = models[0];
    return `Using detected model: ${models[0]}. Detected: ${preview}${suffix}`;
  }

  return `Detected: ${preview}${suffix}`;
}

async function loadModels() {
  modelStatus.textContent = "Checking models";

  try {
    const params = new URLSearchParams();
    const baseUrl = baseUrlInput.value.trim();
    if (baseUrl) {
      params.set("base_url", baseUrl);
    }

    const response = await fetch(`/api/llm-models?${params.toString()}`);
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.detail || "Could not list models");
    }

    modelOptions.innerHTML = "";
    for (const model of payload.models || []) {
      const option = document.createElement("option");
      option.value = model;
      modelOptions.append(option);
    }

    modelStatus.textContent = describeModels(payload.models || []);
  } catch (error) {
    modelStatus.textContent = error.message;
  }
}

async function cleanTranscript() {
  const text = transcript.value.trim();
  if (!text) {
    cleanStatus.textContent = "No text";
    return;
  }

  cleanButton.disabled = true;
  cleanStatus.textContent = "Cleaning";

  try {
    const response = await fetch("/api/clean", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        model: modelInput.value.trim(),
        base_url: baseUrlInput.value.trim(),
        api_key: apiKeyInput.value.trim(),
        system_prompt: systemPrompt.value.trim(),
      }),
    });

    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.detail || "Cleanup failed");
    }

    cleanedTranscript.value = payload.cleaned_text;
    cleanedTranscript.focus();
    cleanedTranscript.selectionStart = cleanedTranscript.value.length;
    cleanedTranscript.selectionEnd = cleanedTranscript.value.length;
    cleanStatus.textContent = "Cleaned";
  } catch (error) {
    cleanStatus.textContent = error.message;
  } finally {
    cleanButton.disabled = false;
  }
}

function toggleSettings() {
  const willOpen = settingsPanel.hidden;
  settingsPanel.hidden = !willOpen;
  settingsButton.setAttribute("aria-expanded", String(willOpen));
  if (willOpen) {
    loadModels().catch((error) => {
      modelStatus.textContent = error.message;
    });
  }
}

async function copyCleanedTranscript() {
  const text = cleanedTranscript.value.trim();
  if (!text) {
    cleanStatus.textContent = "No cleaned text";
    return;
  }

  try {
    await navigator.clipboard.writeText(cleanedTranscript.value);
    cleanStatus.textContent = "Copied";
  } catch {
    cleanedTranscript.focus();
    cleanedTranscript.select();
    cleanStatus.textContent = "Select and copy";
  }
}

recordButton.addEventListener("click", toggleRecording);
cleanButton.addEventListener("click", cleanTranscript);
copyCleanedButton.addEventListener("click", copyCleanedTranscript);
settingsButton.addEventListener("click", toggleSettings);
refreshModelsButton.addEventListener("click", () => {
  loadModels().catch((error) => {
    modelStatus.textContent = error.message;
  });
});
baseUrlInput.addEventListener("change", () => {
  loadModels().catch((error) => {
    modelStatus.textContent = error.message;
  });
});
micSelect.addEventListener("change", () => {
  micStatus.textContent = selectedMicLabel();
});
discardButton.addEventListener("click", () => {
  transcript.value = "";
  cleanedTranscript.value = "";
  transcript.focus();
  updateWordCount();
  cleanStatus.textContent = "Ready";
});
transcript.addEventListener("input", updateWordCount);

loadSettings().catch((error) => {
  cleanStatus.textContent = error.message;
});
loadMicrophones().catch(() => {
  micSelect.innerHTML = '<option value="">Default microphone</option>';
});
navigator.mediaDevices?.addEventListener?.("devicechange", () => {
  loadMicrophones().catch(() => {});
});
setConnection("Ready", true);
updateWordCount();
