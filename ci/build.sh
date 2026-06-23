
prepareBuild() {
  apk add --no-cache postgresql-client
  npm install
  npm run build
}

runTests() {
  npm run test:ci
}
