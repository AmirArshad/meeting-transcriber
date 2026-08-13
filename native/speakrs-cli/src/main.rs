use std::env;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use serde::Serialize;
use speakrs::{ExecutionMode, OwnedDiarizationPipeline};

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
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            let _ = writeln!(
                std::io::stderr(),
                "{message}"
            );
            let payload = ErrorPayload {
                success: false,
                error: single_line(&message),
            };
            if let Ok(json) = serde_json::to_string(&payload) {
                let _ = writeln!(std::io::stdout(), "{json}");
            }
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), String> {
    let wav_path = env::args()
        .nth(1)
        .ok_or_else(|| "usage: speakrs-cli <wav-path>".to_string())?;
    let models_dir = env::var("SPEAKRS_MODELS_DIR")
        .map_err(|_| "SPEAKRS_MODELS_DIR is required".to_string())?;
    let mode_name = env::var("SPEAKRS_MODE").map_err(|_| "SPEAKRS_MODE is required".to_string())?;
    let exclusive = env::var("SPEAKRS_EXCLUSIVE")
        .ok()
        .map(|value| value != "0")
        .unwrap_or(true);

    if env::var_os("SPEAKRS_NUM_SPEAKERS").is_some() {
        return Err(
            "SPEAKRS_NUM_SPEAKERS is not supported; speakrs 0.5.0 is auto-only".to_string(),
        );
    }

    let mode = parse_mode(&mode_name)?;
    let samples = decode_s16le_wav(Path::new(&wav_path))?;
    let mut pipeline = OwnedDiarizationPipeline::from_dir(PathBuf::from(models_dir), mode)
        .map_err(|error| format!("failed to load speakrs models: {error}"))?;
    let result = pipeline
        .run(&samples)
        .map_err(|error| format!("speakrs inference failed: {error}"))?;

    let mut discrete = result.discrete_diarization.clone();
    let annotation_source = if exclusive {
        discrete.make_exclusive();
        "exclusive_speaker_diarization"
    } else {
        "speaker_diarization"
    };
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
        annotation_source: annotation_source.to_string(),
        segments,
    };
    let json = serde_json::to_string(&payload).map_err(|error| error.to_string())?;
    println!("{json}");
    Ok(())
}

fn parse_mode(value: &str) -> Result<ExecutionMode, String> {
    match value {
        "cpu" => Ok(ExecutionMode::Cpu),
        "coreml" => Ok(ExecutionMode::CoreMl),
        "coreml-fast" => Ok(ExecutionMode::CoreMlFast),
        other => Err(format!("unsupported SPEAKRS_MODE: {other}")),
    }
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

#[cfg(test)]
mod tests {
    use super::normalize_speaker_label;

    #[test]
    fn speaker_labels_keep_speaker_nn() {
        assert_eq!(normalize_speaker_label("SPEAKER_00"), "SPEAKER_00");
        assert_eq!(normalize_speaker_label("0"), "SPEAKER_00");
        assert_eq!(normalize_speaker_label("SPEAKER 3"), "SPEAKER_03");
    }
}
