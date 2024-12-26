module.exports = {
    apps: [{
        name: "imps_service",
        script: "app.js",
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