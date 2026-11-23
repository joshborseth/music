/**
 * On the public address (the server's `access/gate.ts`), a device whose
 * sign-in was revoked still opens the app from the service worker's copy,
 * and then every request fails. So the app asks once as it starts, and a
 * device that's signed out goes to the sign-in page. On the home network a
 * device that isn't signed in is a guest, so the answer is never a 401;
 * offline, the fetch fails and nothing happens.
 */
export const leaveWhenSignedOut = (): void => {
  fetch('/signed-in', { method: 'HEAD', cache: 'no-store' }).then(
    response => {
      if (response.status === 401) {
        window.location.replace('/sign-in')
      }
    },
    () => undefined,
  )
}
