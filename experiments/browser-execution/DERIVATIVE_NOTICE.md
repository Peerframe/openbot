# Experimental profile modification notice

Derived from Microsoft Playwright v1.62.1 seccomp_profile.json, licensed Apache-2.0. Original LICENSE and NOTICE are included unmodified.

Official profile SHA256: cc3e61cabda6bbc1e53e54d27ba4d55a9d3be829b6dd1a596f4a7b31b1cc7849.
Tested b1 parent SHA256: 7f0ed0462891ff48435b5f1e486ef94a8469d3b9f86aeb209140293da8b23bae.
This candidate SHA256: d00ad84f5a67031fe2bb64de8d77a5ad9c06adb82935ebdb3c18b5f7ba60a5d0.

The inherited b1 change allows guest clone3. The new change removes the capability condition from the existing unique chroot allow rule. It grants a new guest syscall permission independent of initial container bounding caps; it is not an errno-only adjustment, path-restricted permission, upstream official policy or production approval. No host/container capability is added. UID1001, cap-dropALL, NNP, OCI filtering, runsc, original network/mount/resource bounds and180s deadline remain.

This derivative is prepared by OpenBot for a separately authorized bounded compatibility experiment. A1b's prior result is not browser acceptance. The candidate has not been executed or uploaded when frozen.

## CDP diagnosis candidate

This candidate keeps the b2 profile byte-identical. The new bounded CDP ASCII-NUL transport narrowly adapts Playwright v1.62.1 pipeTransport.ts behavior, originally copyright2018 Google Inc.; modifications copyright Microsoft Corporation, Apache2.0. See playwright-LICENSE and playwright-NOTICE. OpenBot adds the closed qualification sequence, resource/output bounds and stage observations. No new upstream runtime source/package is installed; only existing image Chromium and Node built-ins are used. The candidate does not certify Linux/runsc compatibility before its separate actual run.
