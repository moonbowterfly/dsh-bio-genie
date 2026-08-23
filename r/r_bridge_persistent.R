# dsh-bio-genie R 持久化执行桥
# 保持 R 进程常驻，通过 stdin 接收代码，stdout 返回结果
# 协议：发送 JSON {code, id}，接收 JSON {ok, stdout, stderr, result, id}

suppressPackageStartupMessages(suppressWarnings(library(jsonlite)))

read_stdin_raw <- function() {
  con <- file("stdin", open = "rb")
  on.exit(close(con))
  readBin(con, what = "raw", n = 50L * 1024L * 1024L)
}

emit <- function(obj) {
  txt <- tryCatch(
    toJSON(obj, auto_unbox = TRUE, null = "null", na = "null", digits = NA),
    error = function(e) paste0('{"ok":false,"stdout":"","stderr":"","error":"', e$message, '"}')
  )
  cat(paste0(txt, "\n"))
  flush(stdout())
  invisible(NULL)
}

# 主循环：持续读取请求并执行
repeat {
  raw <- tryCatch(read_stdin_raw(), error = function(e) raw(0))
  if (length(raw) == 0) {
    Sys.sleep(0.1)
    next
  }
  
  txt <- rawToChar(raw, multiple = FALSE)
  if (is.na(txt) || !nzchar(txt)) next
  Encoding(txt) <- "UTF-8"
  
  payload <- tryCatch(fromJSON(txt, simplifyVector = TRUE), error = function(e) NULL)
  if (is.null(payload) || is.null(payload$code) || is.null(payload$id)) next
  
  id <- payload$id
  code <- payload$code
  
  out <- tryCatch({
    # 重定向输出
    con_out <- textConnection("stdout_val", "w", local = TRUE)
    con_err <- textConnection("stderr_val", "w", local = TRUE)
    sink(con_out, type = "output")
    sink(con_err, type = "message")
    
    result <- tryCatch(
      eval(parse(text = code), envir = globalenv()),
      error = function(e) {
        cat(paste("Error:", conditionMessage(e), "\n"), file = stderr())
        NULL
      }
    )
    
    sink(type = "output")
    sink(type = "message")
    
    # 序列化 result
    serialized <- tryCatch(
      toJSON(result, auto_unbox = TRUE, null = "null", na = "null", digits = NA),
      error = function(e) NULL
    )
    
    list(
      ok = TRUE,
      stdout = paste(stdout_val, collapse = "\n"),
      stderr = paste(stderr_val, collapse = "\n"),
      result = result
    )
  }, error = function(e) {
    sink(type = "output")
    sink(type = "message")
    list(ok = FALSE, stdout = "", stderr = paste("Bridge error:", e$message), result = NULL)
  })
  
  out$id <- id
  emit(out)
}
