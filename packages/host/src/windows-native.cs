// Compiled by the trusted Windows PowerShell 5.1 helper. Keep compatible with its C# compiler.
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using Microsoft.Win32;
using Microsoft.Win32.SafeHandles;

public static class VestWindowsStorage
{
    const uint ReadControl = 0x00020000, WriteDac = 0x00040000, WriteOwner = 0x00080000;
    const uint DeleteAccess = 0x00010000, GenericRead = 0x80000000, GenericWrite = 0x40000000;
    const uint ShareRead = 1, ShareWrite = 2, ShareDelete = 4, CreateNew = 1, OpenExisting = 3;
    const uint BackupSemantics = 0x02000000, OpenReparsePoint = 0x00200000, WriteThrough = 0x80000000;
    const uint DirectoryAttribute = 0x10, ReparseAttribute = 0x400;
    const uint OwnerSecurity = 1, DaclSecurity = 4, ProtectedDaclSecurity = 0x80000000;
    const int MaximumBytes = 64 * 1024 * 1024;
    static readonly SecurityIdentifier User = WindowsIdentity.GetCurrent().User;
    static readonly SecurityIdentifier SystemSid = new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null);
    static readonly SecurityIdentifier AdminSid = new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null);

    [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes {
        public int Length; public IntPtr Descriptor; [MarshalAs(UnmanagedType.Bool)] public bool Inherit;
    }
    [StructLayout(LayoutKind.Sequential)] struct FileInformation {
        public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME Creation;
        public System.Runtime.InteropServices.ComTypes.FILETIME Access; public System.Runtime.InteropServices.ComTypes.FILETIME Write;
        public uint VolumeSerial, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    [StructLayout(LayoutKind.Sequential)] struct Disposition { [MarshalAs(UnmanagedType.U1)] public bool Delete; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr attributes, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "CreateFileW")]
    static extern SafeFileHandle CreateSecureFile(string path, uint access, uint share, ref SecurityAttributes attributes, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateDirectoryW(string path, ref SecurityAttributes attributes);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FileInformation info);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint GetFileType(SafeFileHandle handle);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle, StringBuilder path, uint size, uint flags);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool GetVolumeInformationByHandleW(SafeFileHandle handle, StringBuilder volume, uint volumeSize,
        out uint serial, out uint maximumComponent, out uint flags, StringBuilder filesystem, uint filesystemSize);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern uint GetDriveTypeW(string root);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool MoveFileExW(string source, string destination, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetFileInformationByHandle(SafeFileHandle handle, int infoClass, ref Disposition info, uint size);
    [DllImport("advapi32.dll", SetLastError = true)] static extern uint GetSecurityInfo(SafeFileHandle handle, int type, uint information,
        out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
    [DllImport("advapi32.dll", SetLastError = true)] static extern uint SetSecurityInfo(SafeFileHandle handle, int type, uint information,
        IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string text, uint revision, out IntPtr descriptor, out uint size);
    [DllImport("advapi32.dll", SetLastError = true)] static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetSecurityDescriptorOwner(IntPtr descriptor, out IntPtr owner, out bool defaulted);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetSecurityDescriptorDacl(IntPtr descriptor, out bool present, out IntPtr dacl, out bool defaulted);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr value);

    static void Reject() { throw new InvalidOperationException("HOST_STORAGE_REJECTED"); }
    static string Canonical(string path)
    {
        if (String.IsNullOrEmpty(path) || path.Length < 3 || !Char.IsLetter(path[0]) || path[1] != ':' ||
            (path[2] != '\\' && path[2] != '/') || path.IndexOf('\0') >= 0 || path.IndexOf(':', 2) >= 0) Reject();
        string full = Path.GetFullPath(path).Replace('/', '\\');
        if (full.Length > 3) full = full.TrimEnd('\\');
        foreach (string part in full.Substring(3).Split('\\'))
            if (part.Length > 0 && (part.EndsWith(" ", StringComparison.Ordinal) || part.EndsWith(".", StringComparison.Ordinal))) Reject();
        if (GetDriveTypeW(full.Substring(0, 3)) != 3) Reject(); // Local fixed disks only; mapped shares are rejected.
        return full;
    }
    static string Native(string path) { return "\\\\?\\" + path; }
    static bool Missing(int error) { return error == 2 || error == 3; }
    static bool Exists(int error) { return error == 80 || error == 183; }
    static SafeFileHandle Open(string path, uint access, uint share)
    {
        SafeFileHandle handle = CreateFileW(Native(path), access, share, IntPtr.Zero, OpenExisting, BackupSemantics | OpenReparsePoint, IntPtr.Zero);
        if (handle.IsInvalid) { handle.Dispose(); Reject(); }
        return handle;
    }
    static void CheckTopology(SafeFileHandle handle, string path, bool directory)
    {
        FileInformation info;
        if (!GetFileInformationByHandle(handle, out info) || GetFileType(handle) != 1 ||
            (info.Attributes & ReparseAttribute) != 0 || ((info.Attributes & DirectoryAttribute) != 0) != directory ||
            (!directory && info.Links != 1)) Reject();
        StringBuilder actual = new StringBuilder(32768);
        uint length = GetFinalPathNameByHandleW(handle, actual, (uint)actual.Capacity, 0);
        if (length == 0 || length >= actual.Capacity || !String.Equals(actual.ToString().TrimEnd('\\'), Native(path).TrimEnd('\\'), StringComparison.OrdinalIgnoreCase)) Reject();
        uint serial, component, flags;
        StringBuilder filesystem = new StringBuilder(32);
        if (!GetVolumeInformationByHandleW(handle, null, 0, out serial, out component, out flags, filesystem, (uint)filesystem.Capacity) ||
            !String.Equals(filesystem.ToString(), "NTFS", StringComparison.OrdinalIgnoreCase)) Reject();
    }
    static RawSecurityDescriptor Security(SafeFileHandle handle)
    {
        IntPtr owner, group, dacl, sacl, descriptor;
        uint result = GetSecurityInfo(handle, 1, OwnerSecurity | DaclSecurity, out owner, out group, out dacl, out sacl, out descriptor);
        if (result != 0) Reject();
        try {
            uint length = GetSecurityDescriptorLength(descriptor);
            if (length == 0 || length > 65536) Reject();
            byte[] bytes = new byte[length]; Marshal.Copy(descriptor, bytes, 0, bytes.Length);
            return new RawSecurityDescriptor(bytes, 0);
        } finally { LocalFree(descriptor); }
    }
    static void CheckPrivate(SafeFileHandle handle)
    {
        RawSecurityDescriptor descriptor = Security(handle);
        if (descriptor.Owner == null || !descriptor.Owner.Equals(User) || descriptor.DiscretionaryAcl == null ||
            descriptor.DiscretionaryAcl.Count == 0 || (descriptor.ControlFlags & ControlFlags.DiscretionaryAclProtected) == 0) Reject();
        foreach (GenericAce entry in descriptor.DiscretionaryAcl) {
            CommonAce ace = entry as CommonAce;
            if (ace == null || ace.IsCallback || ace.AceQualifier != AceQualifier.AccessAllowed ||
                (!ace.SecurityIdentifier.Equals(User) && !ace.SecurityIdentifier.Equals(SystemSid) && !ace.SecurityIdentifier.Equals(AdminSid))) Reject();
        }
    }
    sealed class Descriptor : IDisposable {
        public SecurityAttributes Attributes;
        public Descriptor(bool directory) {
            string inherit = directory ? "OICI" : "";
            string text = "O:" + User.Value + "G:" + User.Value + "D:P(A;" + inherit + ";FA;;;" + User.Value + ")(A;" + inherit + ";FA;;;SY)(A;" + inherit + ";FA;;;BA)";
            IntPtr descriptor; uint size;
            if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(text, 1, out descriptor, out size)) Reject();
            Attributes = new SecurityAttributes { Length = Marshal.SizeOf(typeof(SecurityAttributes)), Descriptor = descriptor, Inherit = false };
        }
        public void Dispose() { if (Attributes.Descriptor != IntPtr.Zero) { LocalFree(Attributes.Descriptor); Attributes.Descriptor = IntPtr.Zero; } }
    }
    // Holding every component without FILE_SHARE_DELETE prevents directory rename/reparse substitution during an operation.
    sealed class DirectoryChain : IDisposable {
        readonly List<SafeFileHandle> handles = new List<SafeFileHandle>();
        public SafeFileHandle Last { get { return handles[handles.Count - 1]; } }
        public DirectoryChain(string path, bool create, bool privateTarget, uint targetAccess) {
            try {
                string component = path.Substring(0, 3);
                Add(component, false, false, ReadControl);
                string remainder = path.Substring(3);
                if (remainder.Length == 0) { if (privateTarget || create || targetAccess != ReadControl) Reject(); return; }
                string[] parts = remainder.Split('\\');
                for (int index = 0; index < parts.Length; index++) {
                    component = Path.Combine(component, parts[index]);
                    Add(component, create, privateTarget && index == parts.Length - 1, index == parts.Length - 1 ? targetAccess : ReadControl);
                }
            } catch { Dispose(); throw; }
        }
        void Add(string path, bool create, bool privateTarget, uint access) {
            SafeFileHandle handle = CreateFileW(Native(path), access, ShareRead | ShareWrite, IntPtr.Zero, OpenExisting, BackupSemantics | OpenReparsePoint, IntPtr.Zero);
            bool created = false;
            if (handle.IsInvalid) {
                int error = Marshal.GetLastWin32Error(); handle.Dispose();
                if (!create || !Missing(error)) Reject();
                using (Descriptor descriptor = new Descriptor(true)) {
                    if (!CreateDirectoryW(Native(path), ref descriptor.Attributes)) Reject();
                }
                created = true; handle = Open(path, access, ShareRead | ShareWrite);
            }
            handles.Add(handle); CheckTopology(handle, path, true);
            if (privateTarget || created) CheckPrivate(handle);
        }
        public void Dispose() { for (int i = handles.Count - 1; i >= 0; i--) handles[i].Dispose(); handles.Clear(); }
    }
    static void Harden(SafeFileHandle handle, bool directory)
    {
        RawSecurityDescriptor existing = Security(handle);
        if (existing.Owner == null || (!existing.Owner.Equals(User) && !existing.Owner.Equals(AdminSid))) Reject();
        using (Descriptor descriptor = new Descriptor(directory)) {
            IntPtr owner = IntPtr.Zero, dacl = IntPtr.Zero; bool defaulted, present;
            if (!GetSecurityDescriptorOwner(descriptor.Attributes.Descriptor, out owner, out defaulted) ||
                !GetSecurityDescriptorDacl(descriptor.Attributes.Descriptor, out present, out dacl, out defaulted) || !present || dacl == IntPtr.Zero) Reject();
            if (SetSecurityInfo(handle, 1, OwnerSecurity | DaclSecurity | ProtectedDaclSecurity, owner, IntPtr.Zero, dacl, IntPtr.Zero) != 0) Reject();
        }
        CheckPrivate(handle);
    }
    static byte[] Data(string base64) {
        byte[] data = Convert.FromBase64String(base64);
        if (data.Length > MaximumBytes) Reject(); return data;
    }
    static byte[] Read(SafeFileHandle handle) {
        // Do not close the handle: removal must compare and delete through this very same open object.
        long size, position;
        if (!SetFilePointerEx(handle, 0, out position, 0)) Reject();
        if (!GetFileSizeEx(handle, out size) || size < 0 || size > MaximumBytes) Reject();
        byte[] data = new byte[(int)size]; int offset = 0;
        while (offset < data.Length) {
            byte[] chunk = new byte[Math.Min(65536, data.Length - offset)]; uint count;
            if (!ReadFile(handle, chunk, (uint)chunk.Length, out count, IntPtr.Zero) || count == 0) Reject();
            Buffer.BlockCopy(chunk, 0, data, offset, (int)count); offset += (int)count;
        }
        return data;
    }
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetFileSizeEx(SafeFileHandle handle, out long size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetFilePointerEx(SafeFileHandle handle, long distance, out long position, uint method);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool ReadFile(SafeFileHandle handle, byte[] data, uint length, out uint read, IntPtr overlapped);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool WriteFile(SafeFileHandle handle, byte[] data, uint length, out uint written, IntPtr overlapped);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool FlushFileBuffers(SafeFileHandle handle);
    static void Write(SafeFileHandle handle, byte[] data) {
        int offset = 0;
        while (offset < data.Length) {
            byte[] chunk = new byte[Math.Min(65536, data.Length - offset)]; Buffer.BlockCopy(data, offset, chunk, 0, chunk.Length); uint count;
            if (!WriteFile(handle, chunk, (uint)chunk.Length, out count, IntPtr.Zero) || count == 0) Reject();
            offset += (int)count;
        }
        // Native WRITE_THROUGH plus FlushFileBuffers is the Win32 equivalent of FileStream.Flush(true).
        if (!FlushFileBuffers(handle)) Reject();
    }
    static void DeleteExact(SafeFileHandle handle) {
        Disposition disposition = new Disposition { Delete = true };
        if (!SetFileInformationByHandle(handle, 4, ref disposition, (uint)Marshal.SizeOf(typeof(Disposition)))) Reject();
    }
    static bool Equal(byte[] left, byte[] right) {
        if (left.Length != right.Length) return false;
        int difference = 0; for (int i = 0; i < left.Length; i++) difference |= left[i] ^ right[i];
        return difference == 0;
    }
    static SafeFileHandle NewPrivate(string path, bool allowMove, out bool exists) {
        SafeFileHandle handle;
        using (Descriptor descriptor = new Descriptor(false)) {
            handle = CreateSecureFile(Native(path), GenericRead | GenericWrite | ReadControl | DeleteAccess, ShareRead | (allowMove ? ShareDelete : 0),
                ref descriptor.Attributes, CreateNew, OpenReparsePoint | WriteThrough, IntPtr.Zero);
        }
        exists = false;
        if (handle.IsInvalid) {
            int error = Marshal.GetLastWin32Error(); handle.Dispose();
            if (Exists(error)) { exists = true; return null; } Reject();
        }
        try { CheckTopology(handle, path, false); CheckPrivate(handle); return handle; } catch { handle.Dispose(); throw; }
    }
    public static object Machine() {
        string machine;
        using (RegistryKey hive = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64))
        using (RegistryKey key = hive.OpenSubKey(@"SOFTWARE\Microsoft\Cryptography", false)) {
            machine = key == null ? null : key.GetValue("MachineGuid", null, RegistryValueOptions.DoNotExpandEnvironmentNames) as string;
        }
        Guid parsed = Guid.Empty; if (String.IsNullOrWhiteSpace(machine) || !Guid.TryParse(machine, out parsed) || User == null) Reject();
        return new Dictionary<string, object> { { "machineId", parsed.ToString("D") }, { "sid", User.Value } };
    }
    public static bool EnsureDirectory(string value) {
        string path = Canonical(value); using (DirectoryChain chain = new DirectoryChain(path, true, true, ReadControl)) { return true; }
    }
    public static bool ValidateDirectory(string value) {
        string path = Canonical(value); using (DirectoryChain chain = new DirectoryChain(path, false, true, ReadControl)) { return true; }
    }
    public static bool ProtectDirectory(string value) {
        string path = Canonical(value);
        using (DirectoryChain chain = new DirectoryChain(path, false, false, ReadControl | WriteDac | WriteOwner)) { Harden(chain.Last, true); return true; }
    }
    public static bool ValidateFile(string value) {
        string path = Canonical(value);
        using (DirectoryChain chain = new DirectoryChain(Path.GetDirectoryName(path), false, false, ReadControl))
        using (SafeFileHandle handle = Open(path, ReadControl, ShareRead | ShareWrite)) { CheckTopology(handle, path, false); CheckPrivate(handle); return true; }
    }
    public static bool ProtectFile(string value) {
        string path = Canonical(value);
        using (DirectoryChain chain = new DirectoryChain(Path.GetDirectoryName(path), false, false, ReadControl))
        using (SafeFileHandle handle = Open(path, ReadControl | WriteDac | WriteOwner, ShareRead)) { CheckTopology(handle, path, false); Harden(handle, false); return true; }
    }
    public static string ReadPrivate(string value) {
        string path = Canonical(value);
        using (DirectoryChain chain = new DirectoryChain(Path.GetDirectoryName(path), false, false, ReadControl))
        using (SafeFileHandle handle = Open(path, ReadControl | GenericRead, ShareRead)) { CheckTopology(handle, path, false); CheckPrivate(handle); return Convert.ToBase64String(Read(handle)); }
    }
    public static object WriteExclusive(string value, string base64) {
        string path = Canonical(value); byte[] data = Data(base64);
        using (DirectoryChain chain = new DirectoryChain(Path.GetDirectoryName(path), false, true, ReadControl)) {
            bool exists; using (SafeFileHandle handle = NewPrivate(path, false, out exists)) {
                if (exists) return new Dictionary<string, object> { { "created", false } };
                try { Write(handle, data); } catch { DeleteExact(handle); throw; }
                return new Dictionary<string, object> { { "created", true } };
            }
        }
    }
    public static object Publish(string value, string base64, bool replace) {
        string path = Canonical(value); byte[] data = Data(base64);
        using (DirectoryChain chain = new DirectoryChain(Path.GetDirectoryName(path), false, true, ReadControl)) {
            // Existing destinations must be private regular files, even for a no-overwrite collision.
            SafeFileHandle existing = CreateFileW(Native(path), ReadControl, ShareRead, IntPtr.Zero, OpenExisting, OpenReparsePoint, IntPtr.Zero);
            if (!existing.IsInvalid) {
                using (existing) { CheckTopology(existing, path, false); CheckPrivate(existing); }
                if (!replace) return new Dictionary<string, object> { { "created", false } };
            } else { int error = Marshal.GetLastWin32Error(); existing.Dispose(); if (!Missing(error)) Reject(); }
            string temporary = Path.Combine(Path.GetDirectoryName(path), ".vest-" + Guid.NewGuid().ToString("N") + ".tmp");
            bool exists;
            using (SafeFileHandle handle = NewPrivate(temporary, true, out exists)) {
                if (exists) Reject(); bool moved = false;
                try {
                    Write(handle, data);
                    if (!MoveFileExW(Native(temporary), Native(path), 8 | (replace ? 1U : 0U))) {
                        int error = Marshal.GetLastWin32Error(); if (!replace && Exists(error)) return new Dictionary<string, object> { { "created", false } }; Reject();
                    }
                    // Verify the published object through its still-open handle. Flushes support
                    // process-crash recovery; WRITE_THROUGH is not a promise of power-loss-safe rename.
                    moved = true; CheckTopology(handle, path, false); CheckPrivate(handle);
                    if (!Equal(Read(handle), data)) Reject();
                    return new Dictionary<string, object> { { "created", true } };
                } finally { if (!moved) DeleteExact(handle); }
            }
        }
    }
    public static bool RemoveOwned(string value, string base64) {
        string path = Canonical(value); byte[] expected = Data(base64);
        using (DirectoryChain chain = new DirectoryChain(Path.GetDirectoryName(path), false, true, ReadControl)) {
            SafeFileHandle handle = CreateFileW(Native(path), GenericRead | ReadControl | DeleteAccess, ShareRead, IntPtr.Zero, OpenExisting, OpenReparsePoint, IntPtr.Zero);
            if (handle.IsInvalid) { int error = Marshal.GetLastWin32Error(); handle.Dispose(); if (Missing(error)) return false; Reject(); }
            using (handle) {
                CheckTopology(handle, path, false); CheckPrivate(handle); byte[] actual = Read(handle);
                if (!Equal(actual, expected)) return false; DeleteExact(handle); return true;
            }
        }
    }
}
