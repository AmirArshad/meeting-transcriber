This is ndarray-npy 0.10.0 from crates.io, dual licensed under MIT or Apache-2.0
(see the included license files). The dependency on zip was changed from 6 to
9.0.0 to address RUSTSEC-2026-0429. Two lifetime parameters and fallible ZIP
entry-name decoding were adapted to zip 9 in src/npz.rs. Remove this patch when
upstream supports a fixed zip version and validate NPZ reads and writes again.
