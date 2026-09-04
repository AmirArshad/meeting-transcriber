'use strict';

/**
 * Code-owned Linux-x64 CUDA 12 runtime catalog.
 *
 * A user-writable manifest never authorizes these artifacts. Hashes and sizes
 * here are the only accepted values for download and extracted-library checks.
 */

function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      freezeDeep(item);
    }
    return Object.freeze(value);
  }
  for (const nested of Object.values(value)) {
    freezeDeep(nested);
  }
  return Object.freeze(value);
}

const LINUX_CUDA_DRIVER_LIBRARY_ALLOWLIST = Object.freeze([
  '/usr/lib',
  '/usr/lib64',
  '/usr/lib/x86_64-linux-gnu',
]);

const LINUX_CUDA12_RUNTIME_CATALOG = freezeDeep({
  id: 'linux-x64-cuda12',
  architecture: 'x64',
  platform: 'linux',
  cudaMajor: 12,
  managedRelativeRoot: 'ai-addons/cuda/python',
  libraryRelativeDirs: Object.freeze([
    'nvidia/cublas/lib',
    'nvidia/cudnn/lib',
  ]),
  wheels: Object.freeze([
    Object.freeze({
      id: 'nvidia-cublas-cu12',
      packageName: 'nvidia-cublas-cu12',
      version: '12.9.2.10',
      fileName: 'nvidia_cublas_cu12-12.9.2.10-py3-none-manylinux_2_27_x86_64.whl',
      sha256: 'e4f53a8ca8c5d6e8c492d0d0a3d565ecb59a751b19cfdaa4f6da0ab2104c1702',
      sizeBytes: 581240110,
      downloadUrl: 'https://files.pythonhosted.org/packages/cb/c0/0a517bfe63ccd3b92eb254d264e28fca3c7cab75d07daea315250fb1bf73/nvidia_cublas_cu12-12.9.2.10-py3-none-manylinux_2_27_x86_64.whl',
      license: 'NVIDIA proprietary (LicenseRef-NVIDIA-Proprietary)',
      licenseUrl: 'https://docs.nvidia.com/cuda/eula/index.html',
    }),
    Object.freeze({
      id: 'nvidia-cudnn-cu12',
      packageName: 'nvidia-cudnn-cu12',
      version: '9.22.0.52',
      fileName: 'nvidia_cudnn_cu12-9.22.0.52-py3-none-manylinux_2_27_x86_64.whl',
      sha256: '391b9a7ee6386daaca7f8dca41e83c2c99f760c9581a0400755e87b4287b8847',
      sizeBytes: 718382818,
      downloadUrl: 'https://files.pythonhosted.org/packages/a0/8f/2ede6b758b7524608472010f632bdd3370ea271d715d1d66044614b84cdc/nvidia_cudnn_cu12-9.22.0.52-py3-none-manylinux_2_27_x86_64.whl',
      license: 'NVIDIA proprietary',
      licenseUrl: 'https://docs.nvidia.com/deeplearning/cudnn/latest/reference/eula.html',
    }),
  ]),
  requiredLibraries: Object.freeze([
    Object.freeze({
      fileName: 'libcublas.so.12',
      relativePath: 'nvidia/cublas/lib/libcublas.so.12',
      sha256: '5757ab5839fb4f203ca47ecb336110d10f4a5606b1e097f195fbca89774569e2',
      sizeBytes: 105140976,
    }),
    Object.freeze({
      fileName: 'libcublasLt.so.12',
      relativePath: 'nvidia/cublas/lib/libcublasLt.so.12',
      sha256: '2c9006a75c74b3bea2dc7ae2ec38ab038b0e45ea02cb4b717a915e8a5796acb1',
      sizeBytes: 749210000,
    }),
    Object.freeze({
      fileName: 'libnvblas.so.12',
      relativePath: 'nvidia/cublas/lib/libnvblas.so.12',
      sha256: '188c9ff9a2814220ef99ae8d2ebc2b77614c1e5fb527f93bae66d011ad518fc8',
      sizeBytes: 753824,
    }),
    Object.freeze({
      fileName: 'libcudnn.so.9',
      relativePath: 'nvidia/cudnn/lib/libcudnn.so.9',
      sha256: '58bd2f88d0d18f9a40cd14463755a1074023f2413bd9a3ae6de487b3dc18e96d',
      sizeBytes: 129240,
    }),
    Object.freeze({
      fileName: 'libcudnn_adv.so.9',
      relativePath: 'nvidia/cudnn/lib/libcudnn_adv.so.9',
      sha256: '573f6e0458ea5e3225dd1b3d5c3fe404f65ece893cdd55222874a2c179932b78',
      sizeBytes: 272749720,
    }),
    Object.freeze({
      fileName: 'libcudnn_cnn.so.9',
      relativePath: 'nvidia/cudnn/lib/libcudnn_cnn.so.9',
      sha256: '75d17cb50fd302ad7f6a8fac3ebc7b45c83a6b242e8ee7e0cf37264c8bd058fb',
      sizeBytes: 4203896,
    }),
    Object.freeze({
      fileName: 'libcudnn_engines_precompiled.so.9',
      relativePath: 'nvidia/cudnn/lib/libcudnn_engines_precompiled.so.9',
      sha256: '4be8c6ae70a9d28b0bd103634a75a17f8e7f06c1da336978ad7244f00dca4a8c',
      sizeBytes: 518021656,
    }),
    Object.freeze({
      fileName: 'libcudnn_engines_runtime_compiled.so.9',
      relativePath: 'nvidia/cudnn/lib/libcudnn_engines_runtime_compiled.so.9',
      sha256: 'e94f122f41ba854c6c00cd7c394c99121af9054e7922f6dd9bc5868b76462f21',
      sizeBytes: 33585648,
    }),
    Object.freeze({
      fileName: 'libcudnn_engines_tensor_ir.so.9',
      relativePath: 'nvidia/cudnn/lib/libcudnn_engines_tensor_ir.so.9',
      sha256: '8edc656385bfbf95a575039bb13dc9fe29a7b88dbd086957f9fe531df02d4aef',
      sizeBytes: 2099032,
    }),
    Object.freeze({
      fileName: 'libcudnn_ext.so.9',
      relativePath: 'nvidia/cudnn/lib/libcudnn_ext.so.9',
      sha256: '52ef95ca35d82cf757751737bd0b7d7ea554410f06a2d6f37b70931aa8ab5173',
      sizeBytes: 20977696,
    }),
    Object.freeze({
      fileName: 'libcudnn_graph.so.9',
      relativePath: 'nvidia/cudnn/lib/libcudnn_graph.so.9',
      sha256: 'cc87792b8bbaac218378b01fa1d7216758ffb42b6a2852a1b84a3d72150c2411',
      sizeBytes: 115633800,
    }),
    Object.freeze({
      fileName: 'libcudnn_heuristic.so.9',
      relativePath: 'nvidia/cudnn/lib/libcudnn_heuristic.so.9',
      sha256: '2edeb2ca0632e7c739b8730acff9e9605c4ec5088d369a599d22af2bb5ac46bd',
      sizeBytes: 62919352,
    }),
    Object.freeze({
      fileName: 'libcudnn_ops.so.9',
      relativePath: 'nvidia/cudnn/lib/libcudnn_ops.so.9',
      sha256: '1c2c8994fc6def0961ec917da30f09c099135a37755642522dd48688ce17fa9c',
      sizeBytes: 106964632,
    }),
  ]),
  probeLibraryFileNames: Object.freeze([
    'libcublas.so.12',
    'libcublasLt.so.12',
    'libcudnn.so.9',
  ]),
  unsupportedLibraryPrefixes: Object.freeze([
    'libcublas.so.13',
    'libcublaslt.so.13',
  ]),
});

function isPinnedSha256(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function getLinuxCuda12RuntimeCatalog() {
  return LINUX_CUDA12_RUNTIME_CATALOG;
}

function getLinuxCudaDriverLibraryAllowlist() {
  return [...LINUX_CUDA_DRIVER_LIBRARY_ALLOWLIST];
}

function getLinuxCudaWheelPins() {
  return LINUX_CUDA12_RUNTIME_CATALOG.wheels.map((wheel) => ({ ...wheel }));
}

function getLinuxCudaRequiredLibraries() {
  return LINUX_CUDA12_RUNTIME_CATALOG.requiredLibraries.map((library) => ({ ...library }));
}

function getLinuxCudaProbeLibraryFileNames() {
  return [...LINUX_CUDA12_RUNTIME_CATALOG.probeLibraryFileNames];
}

function assertLinuxCudaCatalogIntegrity(catalog = LINUX_CUDA12_RUNTIME_CATALOG) {
  if (!catalog || catalog.architecture !== 'x64' || catalog.platform !== 'linux') {
    throw new Error('Linux CUDA catalog must target linux-x64.');
  }
  if (!Array.isArray(catalog.wheels) || catalog.wheels.length === 0) {
    throw new Error('Linux CUDA catalog must pin at least one wheel.');
  }
  for (const wheel of catalog.wheels) {
    if (!wheel.fileName || !wheel.downloadUrl || !isPinnedSha256(wheel.sha256) || !Number(wheel.sizeBytes)) {
      throw new Error(`Linux CUDA wheel pin is incomplete: ${wheel && wheel.id}`);
    }
    if (!String(wheel.downloadUrl).startsWith('https://files.pythonhosted.org/')) {
      throw new Error(`Linux CUDA wheel URL must be a direct official PyPI object: ${wheel.id}`);
    }
  }
  for (const library of catalog.requiredLibraries || []) {
    if (!library.fileName || !library.relativePath || !isPinnedSha256(library.sha256) || !Number(library.sizeBytes)) {
      throw new Error(`Linux CUDA library pin is incomplete: ${library && library.fileName}`);
    }
    if (String(library.relativePath).includes('..') || String(library.relativePath).startsWith('/')) {
      throw new Error(`Linux CUDA library pin must be a contained relative path: ${library.fileName}`);
    }
  }
  return catalog;
}

module.exports = {
  LINUX_CUDA12_RUNTIME_CATALOG,
  LINUX_CUDA_DRIVER_LIBRARY_ALLOWLIST,
  assertLinuxCudaCatalogIntegrity,
  getLinuxCuda12RuntimeCatalog,
  getLinuxCudaDriverLibraryAllowlist,
  getLinuxCudaProbeLibraryFileNames,
  getLinuxCudaRequiredLibraries,
  getLinuxCudaWheelPins,
  isPinnedSha256,
};
