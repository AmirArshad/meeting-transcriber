use std::env;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use serde::Serialize;
use speakrs::{ExecutionMode, OwnedDiarizationPipeline};

const ANNOTATION_SOURCE_EXCLUSIVE: &str = "exclusive_speaker_diarization";
const ANNOTATION_SOURCE_OVERLAP: &str = "speaker_diarization";
const MODELS_SETUP_ERROR: &str =
    "SPEAKRS_MODELS_DIR is missing or incomplete; re-run speaker setup";

#[derive(Serialize)]
struct SuccessPayload {
    success: bool,
    device: String,
    #[serde(rename = "annotationSource")]
    annotation_source: String,
    segments: Vec<SegmentPayload>,
}

#[derive(Serialize)]
struct SegmentPayload {
    start: f32,
    end: f32,
    speaker: String,
}

#[derive(Serialize)]
struct ErrorPayload {
    success: bool,
    error: String,
}

fn main() -> ExitCode {
    if let Err(message) = install_shutdown_handlers() {
        let _ = writeln!(std::io::stderr(), "{message}");
        emit_error(&message);
        return ExitCode::FAILURE;
    }
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            let _ = writeln!(std::io::stderr(), "{message}");
            emit_error(&message);
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), String> {
    let wav_path = env::args()
        .nth(1)
        .ok_or_else(|| "usage: speakrs-cli <wav-path>".to_string())?;
    let models_dir = env::var("SPEAKRS_MODELS_DIR").map_err(|_| MODELS_SETUP_ERROR.to_string())?;
    if models_dir.trim().is_empty() {
        return Err(MODELS_SETUP_ERROR.to_string());
    }
    let mode_name = env::var("SPEAKRS_MODE").map_err(|_| "SPEAKRS_MODE is required".to_string())?;
    let exclusive = parse_exclusive(env::var("SPEAKRS_EXCLUSIVE").ok().as_deref());

    if env::var_os("SPEAKRS_NUM_SPEAKERS").is_some() {
        return Err(
            "SPEAKRS_NUM_SPEAKERS is not supported; speakrs 0.5.0 is auto-only".to_string(),
        );
    }

    let mode = parse_mode(&mode_name)?;
    assert_models_dir(Path::new(&models_dir))?;
    let samples = decode_s16le_wav(Path::new(&wav_path))?;
    let mut pipeline = OwnedDiarizationPipeline::from_dir(PathBuf::from(&models_dir), mode)
        .map_err(|error| format!("{MODELS_SETUP_ERROR}: {error}"))?;
    let result = pipeline
        .run(&samples)
        .map_err(|error| format!("speakrs inference failed: {error}"))?;

    let mut discrete = result.discrete_diarization.clone();
    if exclusive {
        discrete.make_exclusive();
    }
    let segments = discrete
        .to_segments()
        .into_iter()
        .map(|segment| SegmentPayload {
            start: segment.start as f32,
            end: segment.end as f32,
            speaker: normalize_speaker_label(&segment.speaker),
        })
        .collect();

    let payload = SuccessPayload {
        success: true,
        device: mode.as_str().to_string(),
        annotation_source: annotation_source(exclusive).to_string(),
        segments,
    };
    let json = serde_json::to_string(&payload).map_err(|error| error.to_string())?;
    println!("{json}");
    Ok(())
}

fn emit_error(message: &str) {
    let payload = ErrorPayload {
        success: false,
        error: single_line(message),
    };
    if let Ok(json) = serde_json::to_string(&payload) {
        let _ = writeln!(std::io::stdout(), "{json}");
    }
}

fn parse_exclusive(value: Option<&str>) -> bool {
    value.is_none_or(|raw| raw != "0")
}

fn annotation_source(exclusive: bool) -> &'static str {
    if exclusive {
        ANNOTATION_SOURCE_EXCLUSIVE
    } else {
        ANNOTATION_SOURCE_OVERLAP
    }
}

fn parse_mode(value: &str) -> Result<ExecutionMode, String> {
    match value {
        "cpu" => Ok(ExecutionMode::Cpu),
        "coreml" => Ok(ExecutionMode::CoreMl),
        "cuda" => Ok(ExecutionMode::Cuda),
        other => Err(format!(
            "unsupported SPEAKRS_MODE: {other} (expected cpu, coreml, or cuda)"
        )),
    }
}

fn assert_models_dir(path: &Path) -> Result<(), String> {
    if !path.is_dir() {
        return Err(MODELS_SETUP_ERROR.to_string());
    }
    let mut entries = path
        .read_dir()
        .map_err(|_| MODELS_SETUP_ERROR.to_string())?;
    if entries.next().is_none() {
        return Err(MODELS_SETUP_ERROR.to_string());
    }
    Ok(())
}

fn normalize_speaker_label(label: &str) -> String {
    let trimmed = label.trim();
    if trimmed.starts_with("SPEAKER_") {
        return trimmed.to_string();
    }
    if let Some(digits) = trimmed
        .strip_prefix("SPEAKER")
        .or_else(|| trimmed.strip_prefix("speaker"))
        .or_else(|| trimmed.strip_prefix("Speaker"))
    {
        let digits = digits.trim_start_matches([' ', '_']);
        if digits.chars().all(|ch| ch.is_ascii_digit()) && !digits.is_empty() {
            return format!("SPEAKER_{digits:0>2}");
        }
    }
    if trimmed.chars().all(|ch| ch.is_ascii_digit()) && !trimmed.is_empty() {
        return format!("SPEAKER_{trimmed:0>2}");
    }
    trimmed.to_string()
}

fn single_line(message: &str) -> String {
    message.replace(['\n', '\r'], " ")
}

fn decode_s16le_wav(path: &Path) -> Result<Vec<f32>, String> {
    let mut file = File::open(path).map_err(|error| format!("cannot open wav: {error}"))?;
    let mut header = [0u8; 12];
    file.read_exact(&mut header)
        .map_err(|error| format!("invalid wav header: {error}"))?;
    if &header[0..4] != b"RIFF" || &header[8..12] != b"WAVE" {
        return Err("input must be a RIFF/WAVE file".to_string());
    }

    let mut format = None;
    let mut pcm = None;
    loop {
        let mut chunk_header = [0u8; 8];
        match file.read_exact(&mut chunk_header) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(error) => return Err(format!("invalid wav chunk: {error}")),
        }
        let chunk_id = &chunk_header[0..4];
        let chunk_size = u32::from_le_bytes(
            chunk_header[4..8]
                .try_into()
                .map_err(|_| "invalid wav chunk size".to_string())?,
        ) as u64;
        if chunk_id == b"fmt " {
            let mut fmt = vec![0u8; chunk_size as usize];
            file.read_exact(&mut fmt)
                .map_err(|error| format!("invalid fmt chunk: {error}"))?;
            if fmt.len() < 16 {
                return Err("fmt chunk is too short".to_string());
            }
            let audio_format = u16::from_le_bytes([fmt[0], fmt[1]]);
            let channels = u16::from_le_bytes([fmt[2], fmt[3]]);
            let sample_rate = u32::from_le_bytes([fmt[4], fmt[5], fmt[6], fmt[7]]);
            let bits_per_sample = u16::from_le_bytes([fmt[14], fmt[15]]);
            format = Some((audio_format, channels, sample_rate, bits_per_sample));
        } else if chunk_id == b"data" {
            let mut data = vec![0u8; chunk_size as usize];
            file.read_exact(&mut data)
                .map_err(|error| format!("invalid data chunk: {error}"))?;
            pcm = Some(data);
        } else {
            file.seek(SeekFrom::Current(chunk_size as i64))
                .map_err(|error| format!("cannot skip wav chunk: {error}"))?;
        }
        if chunk_size % 2 == 1 {
            file.seek(SeekFrom::Current(1)).ok();
        }
    }

    let (audio_format, channels, sample_rate, bits_per_sample) =
        format.ok_or_else(|| "wav is missing a fmt chunk".to_string())?;
    if audio_format != 1 || channels != 1 || sample_rate != 16_000 || bits_per_sample != 16 {
        return Err(format!(
            "expected mono 16 kHz s16le wav, got format={audio_format} channels={channels} rate={sample_rate} bits={bits_per_sample}"
        ));
    }
    let data = pcm.ok_or_else(|| "wav is missing a data chunk".to_string())?;
    if data.len() % 2 != 0 {
        return Err("wav data chunk is truncated".to_string());
    }
    Ok(data
        .chunks_exact(2)
        .map(|chunk| i16::from_le_bytes([chunk[0], chunk[1]]) as f32 / 32768.0)
        .collect())
}

fn install_shutdown_handlers() -> Result<(), String> {
    #[cfg(windows)]
    {
        return install_windows_shutdown_handler();
    }
    #[cfg(unix)]
    {
        return install_unix_shutdown_handler();
    }
    #[allow(unreachable_code)]
    Ok(())
}

#[cfg(windows)]
fn install_windows_shutdown_handler() -> Result<(), String> {
    use std::ffi::c_void;

    unsafe extern "system" fn handler(ctrl_type: u32) -> i32 {
        const CTRL_C_EVENT: u32 = 0;
        const CTRL_BREAK_EVENT: u32 = 1;
        const CTRL_CLOSE_EVENT: u32 = 2;
        if matches!(
            ctrl_type,
            CTRL_C_EVENT | CTRL_BREAK_EVENT | CTRL_CLOSE_EVENT
        ) {
            let terminated = unsafe { TerminateProcess(GetCurrentProcess(), 1) };
            return i32::from(terminated != 0);
        }
        0
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetCurrentProcess() -> *mut c_void;
        fn SetConsoleCtrlHandler(
            handler: Option<unsafe extern "system" fn(u32) -> i32>,
            add: i32,
        ) -> i32;
        fn TerminateProcess(process: *mut c_void, exit_code: u32) -> i32;
    }

    let installed = unsafe { SetConsoleCtrlHandler(Some(handler), 1) };
    if installed == 0 {
        return Err("failed to install Windows shutdown handler".to_string());
    }
    Ok(())
}

#[cfg(unix)]
fn install_unix_shutdown_handler() -> Result<(), String> {
    use std::os::raw::c_int;

    unsafe extern "C" fn handler(_signal: c_int) {
        unsafe { immediate_exit(1) }
    }

    unsafe extern "C" {
        fn signal(signum: c_int, handler: Option<unsafe extern "C" fn(c_int)>) -> usize;
        #[link_name = "_exit"]
        fn immediate_exit(status: c_int) -> !;
    }

    const SIGINT: c_int = 2;
    const SIGTERM: c_int = 15;
    const SIG_ERR: usize = usize::MAX;
    for (name, signum) in [("SIGINT", SIGINT), ("SIGTERM", SIGTERM)] {
        if unsafe { signal(signum, Some(handler)) } == SIG_ERR {
            return Err(format!("failed to install {name} shutdown handler"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        ANNOTATION_SOURCE_EXCLUSIVE, ANNOTATION_SOURCE_OVERLAP, ErrorPayload, MODELS_SETUP_ERROR,
        SegmentPayload, SuccessPayload, annotation_source, assert_models_dir, decode_s16le_wav,
        normalize_speaker_label, parse_exclusive, parse_mode, single_line,
    };
    use speakrs::ExecutionMode;
    use std::fs;
    use std::io::Write;
    use std::path::PathBuf;

    fn write_s16le_wav(path: &std::path::Path, samples: &[i16], channels: u16, sample_rate: u32) {
        let data_bytes = samples.len() * 2;
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&(36u32 + data_bytes as u32).to_le_bytes());
        bytes.extend_from_slice(b"WAVE");
        bytes.extend_from_slice(b"fmt ");
        bytes.extend_from_slice(&16u32.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&channels.to_le_bytes());
        bytes.extend_from_slice(&sample_rate.to_le_bytes());
        let byte_rate = sample_rate * u32::from(channels) * 2;
        bytes.extend_from_slice(&byte_rate.to_le_bytes());
        bytes.extend_from_slice(&(channels * 2).to_le_bytes());
        bytes.extend_from_slice(&16u16.to_le_bytes());
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&(data_bytes as u32).to_le_bytes());
        for sample in samples {
            bytes.extend_from_slice(&sample.to_le_bytes());
        }
        let mut file = fs::File::create(path).expect("create wav");
        file.write_all(&bytes).expect("write wav");
    }

    fn temp_path(name: &str) -> PathBuf {
        let mut path = std::env::temp_dir();
        path.push(format!(
            "avanevis-speakrs-cli-{name}-{}",
            std::process::id()
        ));
        path
    }

    #[test]
    fn speaker_labels_keep_speaker_nn() {
        assert_eq!(normalize_speaker_label("SPEAKER_00"), "SPEAKER_00");
        assert_eq!(normalize_speaker_label("0"), "SPEAKER_00");
        assert_eq!(normalize_speaker_label("SPEAKER 3"), "SPEAKER_03");
        assert_eq!(normalize_speaker_label("speaker_01"), "SPEAKER_01");
    }

    #[test]
    fn exclusive_defaults_on_and_maps_sidecar_sources() {
        assert!(parse_exclusive(None));
        assert!(parse_exclusive(Some("1")));
        assert!(!parse_exclusive(Some("0")));
        assert_eq!(annotation_source(true), ANNOTATION_SOURCE_EXCLUSIVE);
        assert_eq!(annotation_source(false), ANNOTATION_SOURCE_OVERLAP);
    }

    #[test]
    fn parse_mode_accepts_only_frozen_modes() {
        assert!(matches!(parse_mode("cpu"), Ok(ExecutionMode::Cpu)));
        assert!(matches!(parse_mode("coreml"), Ok(ExecutionMode::CoreMl)));
        assert!(matches!(parse_mode("cuda"), Ok(ExecutionMode::Cuda)));
        for rejected in ["coreml-fast", "cuda-fast", "migraphx", "", "CPU"] {
            assert!(parse_mode(rejected).is_err(), "{rejected}");
        }
    }

    #[test]
    fn success_json_uses_frozen_field_set() {
        let payload = SuccessPayload {
            success: true,
            device: "cuda".to_string(),
            annotation_source: ANNOTATION_SOURCE_EXCLUSIVE.to_string(),
            segments: vec![SegmentPayload {
                start: 0.0,
                end: 1.5,
                speaker: "SPEAKER_00".to_string(),
            }],
        };
        let value: serde_json::Value =
            serde_json::from_str(&serde_json::to_string(&payload).unwrap()).unwrap();
        let object = value.as_object().unwrap();
        assert_eq!(
            object
                .keys()
                .cloned()
                .collect::<std::collections::BTreeSet<_>>(),
            ["success", "device", "annotationSource", "segments"]
                .into_iter()
                .map(str::to_string)
                .collect()
        );
        assert_eq!(object["success"], true);
        assert_eq!(object["device"], "cuda");
        assert_eq!(object["annotationSource"], ANNOTATION_SOURCE_EXCLUSIVE);
        assert_eq!(object["segments"][0]["speaker"], "SPEAKER_00");
        assert!(object["segments"][0]["start"].is_number());
        assert!(object["segments"][0]["end"].is_number());
    }

    #[test]
    fn failure_json_is_single_line_success_false() {
        let payload = ErrorPayload {
            success: false,
            error: single_line("missing models\nre-run setup"),
        };
        let json = serde_json::to_string(&payload).unwrap();
        assert!(!json.contains('\n'));
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(value["success"], false);
        assert_eq!(value["error"], "missing models re-run setup");
        assert_eq!(value.as_object().unwrap().len(), 2);
    }

    #[test]
    fn missing_models_dir_uses_setup_message() {
        let missing = temp_path("missing-models");
        let _ = fs::remove_dir_all(&missing);
        assert_eq!(assert_models_dir(&missing).unwrap_err(), MODELS_SETUP_ERROR);

        let empty = temp_path("empty-models");
        let _ = fs::remove_dir_all(&empty);
        fs::create_dir_all(&empty).unwrap();
        assert_eq!(assert_models_dir(&empty).unwrap_err(), MODELS_SETUP_ERROR);
        let _ = fs::remove_dir_all(&empty);
    }

    #[test]
    fn decodes_mono_16k_s16le_and_rejects_other_formats() {
        let ok_path = temp_path("ok.wav");
        write_s16le_wav(&ok_path, &[0, 16384, -16384], 1, 16_000);
        let samples = decode_s16le_wav(&ok_path).unwrap();
        assert_eq!(samples.len(), 3);
        assert!((samples[1] - 0.5).abs() < 0.01);
        let _ = fs::remove_file(&ok_path);

        let stereo = temp_path("stereo.wav");
        write_s16le_wav(&stereo, &[0, 0], 2, 16_000);
        assert!(
            decode_s16le_wav(&stereo)
                .unwrap_err()
                .contains("mono 16 kHz")
        );
        let _ = fs::remove_file(&stereo);
    }
}
