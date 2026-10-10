"""Unlock only the selected notary keychain for one job, then restore its state."""
import argparse
import ctypes
import os
from pathlib import Path
import stat
import subprocess
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--keychain', required=True)
    parser.add_argument('--password-file', required=True)
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ['--'] else args.command
    keychain_path = Path(args.keychain)
    if sys.platform != 'darwin' or not keychain_path.is_absolute():
        parser.error('An absolute macOS keychain path is required.')
    if (len(command) < 2 or command[0] != 'notarytool' or command[1] not in ['submit', 'info', 'wait', 'log']
            or command.count('--keychain') != 1):
        parser.error('An explicitly selected notarytool operation is required.')
    index = command.index('--keychain') + 1
    if index >= len(command) or Path(command[index]) != keychain_path:
        parser.error('The command must use the selected notary keychain.')
    security = ctypes.CDLL('/System/Library/Frameworks/Security.framework/Security')
    security.SecKeychainOpen.argtypes = [ctypes.c_char_p, ctypes.POINTER(ctypes.c_void_p)]
    security.SecKeychainGetStatus.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint32)]
    security.SecKeychainUnlock.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_void_p, ctypes.c_bool]
    security.SecKeychainLock.argtypes = [ctypes.c_void_p]
    chain = ctypes.c_void_p()
    if security.SecKeychainOpen(os.fsencode(keychain_path), ctypes.byref(chain)) != 0:
        raise RuntimeError('Cannot open the configured notary keychain.')
    status = ctypes.c_uint32()
    if security.SecKeychainGetStatus(chain, ctypes.byref(status)) != 0:
        raise RuntimeError('Cannot inspect the notary keychain state.')
    originally_unlocked = bool(status.value & 1)
    unlocked_here = False
    secret = bytearray()
    try:
        if not originally_unlocked:
            with os.fdopen(os.open(args.password_file, os.O_RDONLY | os.O_NOFOLLOW), 'rb') as stream:
                metadata = os.fstat(stream.fileno())
                if (not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.getuid()
                        or stat.S_IMODE(metadata.st_mode) != 0o600 or metadata.st_size > 4096):
                    raise RuntimeError('The notary password file must be private, owned by this user, and at most 4096 bytes.')
                secret = bytearray(stream.read().rstrip(b'\r\n'))
            if not secret:
                raise RuntimeError('The notary password file is empty.')
            buffer = (ctypes.c_char * len(secret)).from_buffer(secret)
            if security.SecKeychainUnlock(chain, len(secret), buffer, True) != 0:
                raise RuntimeError('Cannot unlock the configured notary keychain.')
            unlocked_here = True
        result = subprocess.run(['xcrun', *command])
        return result.returncode
    finally:
        secret[:] = bytes(len(secret))
        if unlocked_here and security.SecKeychainLock(chain) != 0:
            raise RuntimeError('Cannot restore the notary keychain lock.')
        if security.SecKeychainGetStatus(chain, ctypes.byref(status)) != 0 or bool(status.value & 1) != originally_unlocked:
            raise RuntimeError('The notary keychain state was not restored.')


if __name__ == '__main__':
    raise SystemExit(main())
