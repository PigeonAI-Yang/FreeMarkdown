mod control;
use control::Control;
use rodio::{buffer::SamplesBuffer, OutputStream, Sink};
use serde::{Deserialize, Serialize};
use sherpa_onnx::{
    GenerationConfig, OfflineTts, OfflineTtsConfig, OfflineTtsZipvoiceModelConfig,
    OfflineTtsModelConfig, Wave,
};
use std::{
    path::Path,
    sync::{
        atomic::Ordering,
        mpsc::{sync_channel, SyncSender},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, State};

fn resolve_model_dir(configured: &str, resources: &Path) -> std::path::PathBuf {
    if !configured.is_empty() { return configured.into(); }
    let path = resources.to_string_lossy();
    let root = if let Some(unc) = path.strip_prefix(r"\\?\UNC\") {
        std::path::PathBuf::from(format!(r"\\{unc}"))
    } else {
        std::path::PathBuf::from(path.strip_prefix(r"\\?\").unwrap_or(&path))
    };
    root.join("readaloud/zipvoice")
}

#[tauri::command]
pub fn readaloud_default_model_dir(app: AppHandle) -> Result<String, String> {
    let resources = app.path().resource_dir().map_err(|e| e.to_string())?;
    let model = resolve_model_dir("", &resources);
    if !model.join("encoder.int8.onnx").is_file() {
        return Err("软件内置的 ZipVoice 模型文件缺失，请重新安装软件或选择本地模型文件夹。".into());
    }
    Ok(model.to_string_lossy().into_owned())
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    token: u64,
    pub id: u32,
    text: String,
    line: u32,
    paragraph: u32,
    chunk: u32,
    model_dir: String,
    voice: i32,
    speed: f32,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Event {
    token: u64,
    kind: String,
    unit: Job,
    error: Option<String>,
    samples: usize,
    synthesis_ms: u128,
    duration_ms: u128,
}
struct Audio {
    job: Job,
    samples: Vec<f32>,
    rate: u32,
    synthesis_ms: u128,
}
pub struct ReadAloud {
    control: Arc<Control>,
    sink: Arc<Mutex<Option<Arc<Sink>>>>,
    sender: Mutex<Option<SyncSender<Job>>>,
}
impl Default for ReadAloud {
    fn default() -> Self {
        Self {
            control: Arc::new(Control::default()),
            sink: Arc::new(Mutex::new(None)),
            sender: Mutex::new(None),
        }
    }
}
fn emit(
    app: &AppHandle,
    job: &Job,
    kind: &str,
    error: Option<String>,
    samples: usize,
    synthesis_ms: u128,
    duration_ms: u128,
) {
    let _ = app.emit(
        "readaloud:event",
        Event {
            token: job.token,
            kind: kind.into(),
            unit: job.clone(),
            error,
            samples,
            synthesis_ms,
            duration_ms,
        },
    );
}
struct Engine {
    tts: OfflineTts,
    reference: Vec<f32>,
    reference_rate: i32,
}
fn create_engine(dir: &str) -> Result<Engine, String> {
    let root = Path::new(dir);
    for file in [
        "encoder.int8.onnx",
        "decoder.int8.onnx",
        "tokens.txt",
        "lexicon.txt",
        "vocos_24khz.onnx",
        "conversation-female.wav",
    ] {
        if !root.join(file).is_file() {
            return Err(format!(
                "模型文件缺失：{file}。请选择完整的 ZipVoice 模型文件夹，或重新安装软件以恢复内置模型。"
            ));
        }
    }
    let path = |name: &str| Some(root.join(name).to_string_lossy().into_owned());
    let config = OfflineTtsConfig {
        model: OfflineTtsModelConfig {
            zipvoice: OfflineTtsZipvoiceModelConfig {
                encoder: path("encoder.int8.onnx"),
                decoder: path("decoder.int8.onnx"),
                tokens: path("tokens.txt"),
                data_dir: path("espeak-ng-data"),
                lexicon: path("lexicon.txt"),
                vocoder: path("vocos_24khz.onnx"),
                feat_scale: 0.1, t_shift: 0.5, target_rms: 0.1, guidance_scale: 1.0,
            },
            num_threads: 2,
            provider: Some("cpu".into()),
            ..Default::default()
        },
        max_num_sentences: 1,
        silence_scale: 1.0,
        ..Default::default()
    };
    if !root.join("espeak-ng-data").is_dir() {
        return Err("模型文件缺失：espeak-ng-data".into());
    }
    let reference = Wave::read(&root.join("conversation-female.wav").to_string_lossy())
        .filter(|wave| wave.num_samples() > 0)
        .ok_or("无法读取对话女声参考音频")?;
    let tts = OfflineTts::create(&config).ok_or("无法加载 ZipVoice 模型，请检查模型文件夹。")?;
    Ok(Engine { tts, reference: reference.samples().to_vec(), reference_rate: reference.sample_rate() })
}
impl ReadAloud {
    fn ensure_worker(&self, app: AppHandle) -> Result<SyncSender<Job>, String> {
        let mut sender = self.sender.lock().map_err(|e| e.to_string())?;
        if let Some(s) = sender.as_ref() {
            return Ok(s.clone());
        }
        let (tx, rx) = sync_channel::<Job>(2);
        let (audio_tx, audio_rx) = sync_channel::<Audio>(2);
        let control = self.control.clone();
        let sink_slot = self.sink.clone();
        let playback_app = app.clone();
        std::thread::Builder::new()
            .name("readaloud-playback".into())
            .spawn(move || {
                let mut output = None;
                while let Ok(audio) = audio_rx.recv() {
                    if !control.accepts(audio.job.token) {
                        continue;
                    }
                    if output.is_none() {
                        match OutputStream::try_default() {
                            Ok(o) => output = Some(o),
                            Err(e) => {
                                emit(
                                    &playback_app,
                                    &audio.job,
                                    "error",
                                    Some(format!("音频设备不可用：{e}")),
                                    0,
                                    0,
                                    0,
                                );
                                continue;
                            }
                        }
                    }
                    let sink = match Sink::try_new(&output.as_ref().unwrap().1) {
                        Ok(s) => Arc::new(s),
                        Err(e) => {
                            emit(
                                &playback_app,
                                &audio.job,
                                "error",
                                Some(e.to_string()),
                                0,
                                0,
                                0,
                            );
                            continue;
                        }
                    };
                    let sample_count = audio.samples.len();
                    let duration = sample_count as u128 * 1000 / audio.rate as u128;
                    {
                        let mut slot = sink_slot.lock().unwrap();
                        if !control.accepts(audio.job.token) {
                            continue;
                        }
                        sink.pause();
                        sink.append(SamplesBuffer::new(1, audio.rate, audio.samples));
                        *slot = Some(sink.clone());
                    }
                    let mut started = false;
                    while control.accepts(audio.job.token) && !sink.empty() {
                        if control.paused.load(Ordering::SeqCst) {
                            sink.pause();
                        } else {
                            sink.play();
                            if !started {
                                emit(
                                    &playback_app,
                                    &audio.job,
                                    "playing",
                                    None,
                                    sample_count,
                                    audio.synthesis_ms,
                                    duration,
                                );
                                started = true;
                            }
                        }
                        std::thread::sleep(Duration::from_millis(15));
                    }
                    sink.stop();
                    if control.accepts(audio.job.token) {
                        emit(
                            &playback_app,
                            &audio.job,
                            "done",
                            None,
                            sample_count,
                            audio.synthesis_ms,
                            duration,
                        );
                    }
                    *sink_slot.lock().unwrap() = None;
                }
            })
            .map_err(|e| e.to_string())?;
        let control = self.control.clone();
        std::thread::Builder::new()
            .name("readaloud-synthesis".into())
            .spawn(move || {
                let mut engine: Option<(String, Engine)> = None;
                while let Ok(job) = rx.recv() {
                    if !control.accepts(job.token) {
                        continue;
                    }
                    let t0 = Instant::now();
                    if engine.as_ref().is_none_or(|(dir, _)| dir != &job.model_dir) {
                        match create_engine(&job.model_dir) {
                            Ok(e) => engine = Some((job.model_dir.clone(), e)),
                            Err(e) => {
                                emit(&app, &job, "error", Some(e), 0, 0, 0);
                                continue;
                            }
                        }
                    }
                    if !control.accepts(job.token) {
                        continue;
                    }
                    let callback_control = control.clone();
                    let token = job.token;
                    let engine = &engine.as_ref().unwrap().1;
                    let result = engine.tts.generate_with_config(
                        &job.text,
                        &GenerationConfig {
                            speed: job.speed,
                            silence_scale: 1.0,
                            reference_audio: Some(engine.reference.clone()),
                            reference_sample_rate: engine.reference_rate,
                            reference_text: Some(include_str!("../../../assets/readaloud/conversation-female.txt").trim().into()),
                            num_steps: 4,
                            extra: Some(std::collections::HashMap::from([
                                ("min_char_in_sentence".into(), serde_json::json!(30)),
                                ("max_char_in_sentence".into(), serde_json::json!(200)),
                            ])),
                            ..Default::default()
                        },
                        Some(move |_: &[f32], _: f32| callback_control.accepts(token)),
                    );
                    if !control.accepts(job.token) {
                        continue;
                    }
                    match result {
                        Some(audio) if !audio.samples().is_empty() => {
                            #[cfg(debug_assertions)]
                            if let Ok(path) = std::env::var("FREEMARKDOWN_TTS_DEBUG_WAV") {
                                if !Path::new(&path).exists() {
                                    let _ = audio.save(&path);
                                }
                            }
                            let item = Audio {
                                job: job.clone(),
                                samples: audio.samples().to_vec(),
                                rate: audio.sample_rate() as u32,
                                synthesis_ms: t0.elapsed().as_millis(),
                            };
                            if audio_tx.send(item).is_err() {
                                break;
                            }
                        }
                        _ => emit(
                            &app,
                            &job,
                            "error",
                            Some("这句话未生成音频，请停止后重试。".into()),
                            0,
                            0,
                            0,
                        ),
                    }
                }
            })
            .map_err(|e| e.to_string())?;
        *sender = Some(tx.clone());
        Ok(tx)
    }
}
#[tauri::command]
pub fn readaloud_reset(state: State<'_, ReadAloud>, token: u64) {
    let mut slot = state.sink.lock().unwrap();
    state.control.reset(token);
    if let Some(s) = slot.take() {
        s.stop();
    }
}
#[tauri::command]
pub fn readaloud_pause(state: State<'_, ReadAloud>, paused: bool) {
    state.control.paused.store(paused, Ordering::SeqCst);
    if let Some(s) = state.sink.lock().unwrap().as_ref() {
        if paused {
            s.pause()
        } else {
            s.play()
        }
    }
}
#[tauri::command]
pub fn readaloud_enqueue(
    app: AppHandle,
    state: State<'_, ReadAloud>,
    mut job: Job,
) -> Result<(), String> {
    if !state.control.accepts(job.token) {
        return Ok(());
    }
    if job.text.chars().count() > 160
        || job.text.contains('\0')
        || job.voice != 0
        || !job.speed.is_finite()
        || !(0.6..=1.6).contains(&job.speed)
    {
        return Err("朗读参数无效".into());
    }
    if job.model_dir.is_empty() {
        job.model_dir = readaloud_default_model_dir(app.clone())?;
    }
    state
        .ensure_worker(app)?
        .try_send(job)
        .map_err(|_| "朗读队列忙，请停止后重试".into())
}

#[cfg(test)]
mod model_path_tests {
    use super::resolve_model_dir;
    use std::path::Path;

    #[test]
    fn readaloud_default_uses_bundle_and_preserves_selected_model() {
        let resources = Path::new(r"C:\Apps\FreeMarkdown");
        assert_eq!(resolve_model_dir("", resources), resources.join("readaloud/zipvoice"));
        assert_eq!(resolve_model_dir(r"D:\MyVoice", resources), Path::new(r"D:\MyVoice"));
        assert_eq!(resolve_model_dir("", Path::new(r"\\?\C:\Apps\FreeMarkdown")), resources.join("readaloud/zipvoice"));
    }
}
