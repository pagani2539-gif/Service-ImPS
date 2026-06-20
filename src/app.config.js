module.exports = {
    apps: [{
        name: "imps_service_v2", // แยกชื่อจาก V1 (เดิมชนกัน "imps_service" → pm2 resurrect เสี่ยงเรียกผิดตัว)
        script: "src/app.js",
        instances: 1,
        exec_mode: "fork", // You can use "fork" or "cluster" mode, depending on your needs
        // Add any environment variables here if needed
        env: {
            NODE_ENV: "production", // You can set your environment variables here
        },
        // Add any environment-specific configurations here
        env_production: {
            NODE_ENV: "production",
        },
    }, ],
};