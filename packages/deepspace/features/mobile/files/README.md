# Mobile app

An Expo SDK 57 client for this DeepSpace app, built on `deepspace/native`. It
reads the app id and `app.space` name from `../wrangler.toml` and pins the same
`deepspace` version as the app.

```sh
npm install
npx expo run:ios        # development build in the iOS Simulator
npx expo run:android    # or an Android emulator
```

Sign-in opens Google in the system browser and returns through
`<scheme>://auth/callback`, which the Worker must list in
`NATIVE_AUTH_REDIRECT_URIS`. `app.config.ts` stops the build and prints the
exact value when it is missing. Expo Go cannot receive that callback, so use a
development build.

Device builds and TestFlight go through EAS (`npx eas build`) and need your own
bundle identifier in `app.config.ts`.
