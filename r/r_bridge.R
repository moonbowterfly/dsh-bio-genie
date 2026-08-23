# dsh-bio-genie R 执行桥（与 python/bridge.py 同构）
#
# stdin 读 JSON 信封 {"code": "<R 源码>", "cwd": "<可选工作目录>"}
# stdout 写一行 JSON：{"ok", "stdout", "stderr", "result", "error"}
#   - result：用户代码顶层变量 result 的值（JSON 可序列化时返回，否则降级为 str 摘要）
#   - 用户代码异常被捕获：ok=TRUE 但 stderr 含 "Error: ..." 与 "Execution halted"，
#     TS 侧据 "Error"/"Execution halted" 判定 needs_repair（同 bridge.py 契约）
#
# UTF-8 纪律：stdin/stdout 走原始字节，不经过 Windows 原生编码层（GBK 环境防乱码）。
# 用户代码的警告被静音（避免污染 stdout 之外的信息通道）。
# 从环境变量读取包库路径并添加到 .libPaths
r_libs <- Sys.getenv("R_LIBS", unset = "")
if (nzchar(r_libs)) {
  r_libs <- normalizePath(r_libs, mustWork = FALSE)
  if (dir.exists(r_libs)) {
    .libPaths(c(r_libs, .libPaths()))
  }
}
suppressPackageStartupMessages(suppressWarnings(library(jsonlite)))

read_stdin_raw <- function() {
  # 读取一行 JSON（简单实现）
  lines <- readLines("stdin", n = 1, warn = FALSE)
  charToRaw(paste(lines, collapse = "
"))
}

emit <- function(obj) {
  txt <- tryCatch(
    toJSON(obj, auto_unbox = TRUE, null = "null", na = "null", digits = NA),
    error = function(e) paste0(
      '{"ok":false,"stdout":"","stderr":"","error":',
      toJSON(paste("bridge serialization failed:", conditionMessage(e))),
      '}'))
  # sink 已在 main() 底部关闭；直接 cat 到已恢复的 stdout（R 4.6.0 Windows 上
  # file("stdout",open="wb") 写不进管道，实测踩坑）
  cat(paste0(txt, "\n"))
  invisible(NULL)
}

`%||%` <- function(a, b) if (is.null(a) || length(a) == 0L) b else a

main <- function() {
  raw <- read_stdin_raw()
  txt <- rawToChar(raw, multiple = FALSE)
  if (is.na(txt) || !nzchar(txt)) txt <- "{}"
  Encoding(txt) <- "UTF-8"
  payload <- tryCatch(fromJSON(txt, simplifyVector = TRUE), error = function(e) NULL)
  if (is.null(payload)) {
    emit(list(ok = FALSE, stdout = "", stderr = "",
              error = "invalid r-bridge envelope (JSON parse failed)"))
    return(invisible(NULL))
  }

  code <- payload$code %||% ""
  cwd <- payload$cwd
  if (!is.null(cwd) && nzchar(cwd) && dir.exists(cwd)) setwd(cwd)

  # 捕获 stdout/stderr 到文件（encoding=UTF-8：原生编码字符串写出时转 UTF-8）
  out_file <- tempfile(fileext = ".txt")
  err_file <- tempfile(fileext = ".txt")
  con_out <- file(out_file, open = "wt", encoding = "UTF-8")
  con_err <- file(err_file, open = "wt", encoding = "UTF-8")
  sink(con_out, type = "output")
  sink(con_err, type = "message")

  had_error <- FALSE
  error_msg <- ""
  env <- new.env(parent = globalenv())
  tryCatch(
    withCallingHandlers(
      eval(parse(text = code, keep.source = FALSE), envir = env),
      warning = function(w) invokeRestart("muffleWarning")),
    error = function(e) { had_error <<- TRUE; error_msg <<- conditionMessage(e) })

  # 恢复 stdout/stderr 捕获（必须在 emit 之前，且 emit 不再额外 sink）
  sink(type = "message")
  sink(type = "output")
  close(con_out)
  close(con_err)

  stdout_txt <- paste(readLines(out_file, warn = FALSE, encoding = "UTF-8"), collapse = "\n")
  stderr_txt <- paste(readLines(err_file, warn = FALSE, encoding = "UTF-8"), collapse = "\n")
  if (had_error) {
    stderr_txt <- paste0(stderr_txt,
                         if (nzchar(stderr_txt)) "\n" else "",
                         "Error: ", error_msg, "\nExecution halted")
  }

  # result 变量：JSON 可序列化则结构化返回，否则降级为 str() 摘要（同 bridge.py _json_safe）
  result_json <- NULL
  if (exists("result", envir = env, inherits = FALSE)) {
    rval <- get("result", envir = env, inherits = FALSE)
    result_json <- tryCatch(
      toJSON(rval, auto_unbox = TRUE, null = "null", na = "null", digits = NA),
      error = function(e) NULL)
    if (is.null(result_json)) {
      result_json <- toJSON(paste(capture.output(str(rval, max.level = 3)),
                                  collapse = "; "), auto_unbox = TRUE)
    }
  }

  emit(list(
    ok = !had_error,
    stdout = stdout_txt,
    stderr = stderr_txt,
    result = if (!is.null(result_json)) fromJSON(result_json, simplifyVector = FALSE) else NULL))
  unlink(c(out_file, err_file))
  invisible(NULL)
}

main()