// socket.io-ს ერთიანი წვდომა კონტროლერებისთვის (server.js-ის circular import-ის გარეშე)
let ioInstance = null;

export const setIo = (io) => {
  ioInstance = io;
};

export const emitToUser = (userId, event, payload) => {
  if (!ioInstance) return;
  ioInstance.to(String(userId)).emit(event, payload);
};

// ყველა ადმინისტრატორი ერთ ოთახშია ("admins"): server.js-ში ავტორიზაციისას უერთდებიან
export const emitToAdmins = (event, payload) => {
  if (!ioInstance) return;
  ioInstance.to("admins").emit(event, payload);
};
