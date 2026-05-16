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

const preferredAudioTypes = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/mp4",
];

const state = {
  audioChunks: [],
  audioContext: null,
  meterFrame: null,
  previewUrl: null,
  recorder: null,
  stream: null,
  timerId: null,
  timerStartedAt: 0,
};

function setConnection(text, live = false) {
  connectionStatus.textContent = text;
  connectionStatus.classList.toggle("live", live);
}

function setRecordingUi(isRecording) {
  recordButton.textContent = isRecording ? "Stop recording" : "Start recording";
  recordButton.classList.toggle("recording", isRecording);
  recordingState.textContent = isRecording ? "Recording" : "Idle";
}

function showRecordingStatus(text) {
  chunkStatus.textContent = text;
}

function showError(error) {
  recordingState.textContent = "Error";
  showRecordingStatus(error.message || "Something went wrong");
  setConnection("Ready", true);
}

function updateWordCount() {
  const words = transcript.value.trim().split(/\s+/).filter(Boolean);
  wordCount.textContent = `${words.length} ${words.length === 1 ? "word" : "words"}`;
}

function insertAtCursor(text) {
  const trimmed = text.trim();
  if (!trimmed) {
    return;
  }

  const start = transcript.selectionStart ?? transcript.value.length;
  const end = transcript.selectionEnd ?? start;
  const before = transcript.value.slice(0, start);
  const after = transcript.value.slice(end);
  const leadingSpace = before && !/[\s\n]$/.test(before) ? " " : "";
  const insert = `${leadingSpace}${trimmed} `;

  transcript.value = `${before}${insert}${after}`;
  transcript.selectionStart = start + insert.length;
  transcript.selectionEnd = transcript.selectionStart;
  transcript.focus();
  updateWordCount();
}

function selectedMicLabel() {
  return micSelect.selectedOptions[0]?.textContent || "Default microphone";
}

function selectedMicConstraints() {
  const audio = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  };

  if (micSelect.value) {
    audio.deviceId = { exact: micSelect.value };
  }

  return { audio };
}

async function loadMicrophones() {
  if (!navigator.mediaDevices?.enumerateDevices) {
    micSelect.replaceChildren(new Option("Default microphone", ""));
    return;
  }

  const previous = micSelect.value;
  const devices = await navigator.mediaDevices.enumerateDevices();
  const microphones = devices.filter((device) => device.kind === "audioinput");
  const options = [new Option("Default microphone", "")];

  for (const [index, device] of microphones.entries()) {
    options.push(new Option(device.label || `Microphone ${index + 1}`, device.deviceId));
  }

  micSelect.replaceChildren(...options);
  if ([...micSelect.options].some((option) => option.value === previous)) {
    micSelect.value = previous;
  }
  micStatus.textContent = selectedMicLabel();
}

function bestAudioType() {
  return preferredAudioTypes.find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

function fileExtensionFor(mimeType) {
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

function isRecording() {
  return state.recorder?.state === "recording";
}

function startTimer() {
  state.timerStartedAt = Date.now();
  timer.textContent = "00:00";
  state.timerId = window.setInterval(() => {
    const elapsedSeconds = Math.floor((Date.now() - state.timerStartedAt) / 1000);
    const minutes = String(Math.floor(elapsedSeconds / 60)).padStart(2, "0");
    const seconds = String(elapsedSeconds % 60).padStart(2, "0");
    timer.textContent = `${minutes}:${seconds}`;
  }, 250);
}

function stopTimer() {
  window.clearInterval(state.timerId);
  state.timerId = null;
}

function startMeter(stream) {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) {
    return;
  }

  state.audioContext = new AudioContextClass();
  const source = state.audioContext.createMediaStreamSource(stream);
  const analyser = state.audioContext.createAnalyser();

  analyser.fftSize = 256;
  const frequencyData = new Uint8Array(analyser.frequencyBinCount);
  source.connect(analyser);

  const draw = () => {
    analyser.getByteFrequencyData(frequencyData);
    const average = frequencyData.reduce((sum, value) => sum + value, 0) / frequencyData.length;
    levelBar.style.transform = `scaleX(${Math.min(1, average / 90)})`;
    state.meterFrame = window.requestAnimationFrame(draw);
  };
  draw();
}

function stopMeter() {
  window.cancelAnimationFrame(state.meterFrame);
  levelBar.style.transform = "scaleX(0)";
  state.audioContext?.close().catch(() => {});
  state.audioContext = null;
  state.meterFrame = null;
}

function releaseMicrophone() {
  state.stream?.getTracks().forEach((track) => track.stop());
  state.stream = null;
}

function resetRecordingTools() {
  stopMeter();
  stopTimer();
  releaseMicrophone();
}

async function startRecording() {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    throw new Error("Recording is not supported in this browser.");
  }

  state.stream = await navigator.mediaDevices.getUserMedia(selectedMicConstraints());
  await loadMicrophones();

  const mimeType = bestAudioType();
  state.audioChunks = [];
  state.recorder = new MediaRecorder(state.stream, mimeType ? { mimeType } : undefined);
  state.recorder.addEventListener("dataavailable", (event) => {
    if (event.data.size) {
      state.audioChunks.push(event.data);
    }
  });

  state.recorder.start();
  startMeter(state.stream);
  startTimer();
  setRecordingUi(true);
  setConnection("Recording", true);
  showRecordingStatus("Recording audio");
  recordingPreview.hidden = true;
}

function stopRecorder() {
  return new Promise((resolve, reject) => {
    if (!isRecording()) {
      reject(new Error("No active recording."));
      return;
    }

    state.recorder.addEventListener(
      "stop",
      () => {
        const mimeType = state.recorder.mimeType || state.audioChunks[0]?.type || "audio/webm";
        resolve(new Blob(state.audioChunks, { type: mimeType }));
      },
      { once: true },
    );

    state.recorder.requestData();
    state.recorder.stop();
  });
}

function showRecordingPreview(blob) {
  if (state.previewUrl) {
    URL.revokeObjectURL(state.previewUrl);
  }

  state.previewUrl = URL.createObjectURL(blob);
  recordingPreview.src = state.previewUrl;
  recordingPreview.hidden = false;
}

async function transcribeRecording(blob) {
  if (!blob.size) {
    throw new Error("No audio was recorded.");
  }

  const formData = new FormData();
  const extension = fileExtensionFor(blob.type || "audio/webm");
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

async function stopRecording() {
  setRecordingUi(false);
  showRecordingStatus("Preparing audio");

  const blob = await stopRecorder();
  resetRecordingTools();
  showRecordingPreview(blob);

  showRecordingStatus(`Transcribing ${Math.round(blob.size / 1024)} KB audio`);
  const text = await transcribeRecording(blob);

  if (text.trim()) {
    insertAtCursor(text);
    showRecordingStatus("Transcript updated");
  } else {
    showRecordingStatus("No speech found");
  }
}

async function toggleRecording() {
  recordButton.disabled = true;

  try {
    if (isRecording()) {
      await stopRecording();
    } else {
      await startRecording();
    }
  } catch (error) {
    resetRecordingTools();
    setRecordingUi(false);
    showError(error);
  } finally {
    recordButton.disabled = false;
    if (!isRecording()) {
      setConnection("Ready", true);
    }
  }
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
    if (baseUrlInput.value.trim()) {
      params.set("base_url", baseUrlInput.value.trim());
    }

    const response = await fetch(`/api/llm-models?${params.toString()}`);
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.detail || "Could not list models");
    }

    modelOptions.replaceChildren(
      ...(payload.models || []).map((model) => {
        const option = document.createElement("option");
        option.value = model;
        return option;
      }),
    );
    modelStatus.textContent = describeModels(payload.models || []);
  } catch (error) {
    modelStatus.textContent = error.message;
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
  if (!cleanedTranscript.value.trim()) {
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

function clearText() {
  transcript.value = "";
  cleanedTranscript.value = "";
  transcript.focus();
  updateWordCount();
  cleanStatus.textContent = "Ready";
}

function refreshModels() {
  loadModels().catch((error) => {
    modelStatus.textContent = error.message;
  });
}

recordButton.addEventListener("click", toggleRecording);
discardButton.addEventListener("click", clearText);
cleanButton.addEventListener("click", cleanTranscript);
copyCleanedButton.addEventListener("click", copyCleanedTranscript);
settingsButton.addEventListener("click", toggleSettings);
refreshModelsButton.addEventListener("click", refreshModels);
baseUrlInput.addEventListener("change", refreshModels);
transcript.addEventListener("input", updateWordCount);
micSelect.addEventListener("change", () => {
  micStatus.textContent = selectedMicLabel();
});
navigator.mediaDevices?.addEventListener?.("devicechange", () => {
  loadMicrophones().catch(() => {});
});

loadSettings().catch((error) => {
  cleanStatus.textContent = error.message;
});
loadMicrophones().catch(() => {
  micSelect.replaceChildren(new Option("Default microphone", ""));
});
setConnection("Ready", true);
updateWordCount();
