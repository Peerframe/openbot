# Bundled standalone Python notices

`NOTICES.txt` preserves the license texts from the exact python-build-standalone commit in `SOURCE.json`, including upstream component copyright notices. The raw source texts were checked against that commit's Git blob identities. The collection is deliberately complete; presence of a component notice does not assert that it is linked into this macOS target. No runtime source is copied or changed.

CPython's own installed license and all installed wheel notices are also retained in the bundled interpreter. The upstream build repository is MPL-2.0; CPython is licensed under PSF terms and linked components retain their own terms. Upstream source and build inputs are available at https://github.com/astral-sh/python-build-standalone/tree/00c8a06113f11220667c3bcf5fab1672ff9e78ef .
