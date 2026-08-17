# dsh-bio R 环境包安装器（R 引导器调用；幂等）
#
# 用法：Rscript install_packages.R <lib_dir> [cran_mirror] [bioc_mirror]
# 读取同目录 requirements-r.txt 安装核心包集。
#
# 策略：
#   - 二进制优先（Windows）：显式 type="binary" + pkgType="binary"
#     —— 无 Rtools 工具链，不走源码编译（源码包直接失败并如实上报）。
#   - 镜像选型（实测）：清华 Bioconductor 镜像 binary 索引在但 zip 缺失（404），
#     必须用官方 bioconductor.org；CRAN 清华镜像完整可用。
#   - Bioconductor 版本固定 3.23（与 R 4.6 配套，见 THIRD_PARTY_NOTICES）。
#   - 幂等：已装包跳过（requireNamespace 探测）。
args_all <- commandArgs(trailingOnly = FALSE)
file_arg <- grep("^--file=", args_all, value = TRUE)
script_dir <- dirname(sub("^--file=", "", file_arg))
req_file <- file.path(script_dir, "requirements-r.txt")

args <- commandArgs(trailingOnly = TRUE)
if (length(args) < 1) {
  cat("usage: Rscript install_packages.R <lib_dir> [cran_mirror] [bioc_mirror]\n")
  quit(status = 1)
}
lib_dir <- args[[1]]
cran_mirror <- if (length(args) >= 2) args[[2]] else "https://mirrors.tuna.tsinghua.edu.cn/CRAN"
bioc_mirror <- if (length(args) >= 3) args[[3]] else "https://bioconductor.org"

dir.create(lib_dir, showWarnings = FALSE, recursive = TRUE)
.libPaths(c(lib_dir, .libPaths()))

options("repos" = c(CRAN = cran_mirror))
options("BioC_mirror" = bioc_mirror)
options("pkgType" = "binary")  # Windows 二进制优先；无二进制的源码包直接失败
options("timeout" = 900)
options("Ncpus" = 2)
Sys.setenv("R_LIBS_USER" = lib_dir)

pkgs <- trimws(readLines(req_file, warn = FALSE, encoding = "UTF-8"))
pkgs <- pkgs[nzchar(pkgs) & !startsWith(pkgs, "#")]

# 完整性探测：不能只看 requireNamespace（半装/依赖断裂的包会误判"已装"，实测 GO.db 踩坑）。
# loadNamespace 真正加载命名空间及其依赖，失败即视为缺失。
has_pkg <- function(p) {
  tryCatch({ loadNamespace(p); TRUE }, error = function(e) FALSE)
}

if (!requireNamespace("BiocManager", quietly = TRUE)) {
  install.packages("BiocManager", type = "binary")
}
suppressMessages(BiocManager::install(version = "3.23", update = FALSE, ask = FALSE, type = "binary"))

missing <- pkgs[!vapply(pkgs, has_pkg, logical(1))]
if (length(missing) > 0) {
  cat("installing:", paste(missing, collapse = ", "), "\n")
  # force=TRUE：覆盖"已装版本≥当前"的误判（上次失败残留下半装包时常见，实测踩坑）
  suppressMessages(BiocManager::install(missing, update = FALSE, ask = FALSE, type = "binary", force = TRUE))
}

final_missing <- pkgs[!vapply(pkgs, has_pkg, logical(1))]
if (length(final_missing) > 0) {
  cat("R-INSTALL-FAIL:", paste(final_missing, collapse = ","), "\n")
  quit(status = 2)
}
cat("R-READY\n")
