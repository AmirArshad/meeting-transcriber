use ndarray::array;
use ndarray_npy::{NpzReader, NpzWriter};
use std::io::Cursor;

#[test]
fn npz_round_trip_preserves_names_and_arrays() {
    let mut writer = NpzWriter::new_compressed(Cursor::new(Vec::new()));
    let expected = array![[1.0_f32, 2.0], [3.0, 4.0]];
    writer.add_array("embedding", &expected).unwrap();
    let bytes = writer.finish().unwrap().into_inner();
    let mut reader = NpzReader::new(Cursor::new(bytes)).unwrap();
    assert_eq!(reader.names().unwrap(), vec!["embedding"]);
    let actual: ndarray::Array2<f32> = reader.by_name("embedding").unwrap();
    assert_eq!(actual, expected);
}
