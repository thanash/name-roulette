module.exports = {
  apps: [{
    name: 'name-roulette',
    script: 'server.js',
    cwd: '/var/www/name-roulette',
    env: {
      NODE_ENV: 'production',
      PORT: 3001,
    },
  }],
};
