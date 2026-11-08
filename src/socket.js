// socket.io-ს ერთიანი წვდომა კონტროლერებისთვის (server.js-ის circular import-ის გარეშე)
let ioInstance = null;

export const setIo = (io) => {
  ioInstance = io;
};

export const emitToUser = (userId, event, payload) => {
  if (!ioInstance) return;
  ioInstance.to(String(userId)).emit(event, payload);
};
