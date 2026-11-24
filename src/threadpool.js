// Imported first by the entry point, before anything touches the file system or DNS: Node sizes
// its libuv thread pool on first use, and the default of 4 makes concurrent lookups (DNS and TLS
// for dozens of registry hosts at once) wait on one another. An explicit setting wins.
process.env.UV_THREADPOOL_SIZE ||= "32";
